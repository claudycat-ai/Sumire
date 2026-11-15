// `llama-server` の監督(llama-server-provider)。
//
// プロセスも HTTP も使わない部品:
// - 起動引数の組み立て(`build_args`)
// - 出力の末尾の入れ物(`LogTail`)
// - 状態と起動の通し番号の状態機械(`StatusMachine`)
// - 画面側に渡す状態の形(`LlamaServerStatus`)
//
// 子プロセスを扱う本体(`Supervisor`):
// - 起動(`start`)、停止(`stop`)、状態と出力の末尾の読み出し
// - 起動ごとに 4 本のスレッドを動かす: 標準出力・標準エラーの読み取り、`/health`
//   の待ち、終了の見張り
//
// 遷移の規則を `StatusMachine` に寄せるのは、プロセスなしで試せるようにするため。
// `Supervisor` は、その部品をロックの中で呼び、変わった状態を送り先に渡すだけ。
//
// Tauri とのつなぎ(`LlamaServerState` と 4 つの command):
// - 監督をアプリの状態として持ち、状態が変わるたびにイベント `llama-server-status`
//   を全ウィンドウに送る
// - アプリの終了で停止する(`LlamaServerState::shutdown`、`lib.rs` から呼ぶ)

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter, State};

/// 状態が変わるたびに全ウィンドウへ送るイベントの名前。フロントの
/// `src/domain/llamaServer/llamaServerApi.ts` と揃える。
const STATUS_EVENT: &str = "llama-server-status";

/// 出力の末尾として持つ行数の上限(Req 5.7)。
pub(crate) const LOG_TAIL_MAX_LINES: usize = 200;

/// `llama-server` の起動引数を組み立てる。
pub(crate) fn build_args(
    model_path: &str,
    context_size: u32,
    port: u16,
    extra_args: &[String],
) -> Vec<String> {
    // `--ctx-size` を必ず明示するのは、省くとモデルの学習時の長さまで広がり、GPU
    // メモリからあふれるため(Req 4.7)。`--parallel 1` は、スロットが複数になって
    // コンテキスト長が分割されるのを防ぐ。`--fit` は渡さず、`llama-server` の既定に
    // 任せる(research.md「Sumire が渡す起動引数は最小限」)。
    let mut args = vec![
        "--model".to_string(),
        model_path.to_string(),
        "--ctx-size".to_string(),
        context_size.to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--parallel".to_string(),
        "1".to_string(),
    ];
    args.extend(extra_args.iter().cloned());
    args
}

/// 標準出力と標準エラーの末尾。
#[derive(Debug, Default)]
pub(crate) struct LogTail {
    lines: VecDeque<String>,
}

impl LogTail {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn push(&mut self, line: String) {
        if self.lines.len() >= LOG_TAIL_MAX_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// 古い順。
    pub(crate) fn lines(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StopCause {
    Initial,
    Requested,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FailureReason {
    Spawn,
    Exited,
}

/// 画面側に渡す状態。フロントの `LlamaServerStatus`
/// (`src/domain/llamaServer/types.ts`)と同じ JSON になる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum LlamaServerStatus {
    #[serde(rename_all = "camelCase")]
    Stopped {
        run_id: u64,
        cause: StopCause,
        exit_code: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    Loading {
        run_id: u64,
        model_path: String,
        context_size: u32,
        port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        run_id: u64,
        model_path: String,
        context_size: u32,
        port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        run_id: u64,
        reason: FailureReason,
        executable_path: String,
        model_path: String,
        message: String,
        exit_code: Option<i32>,
    },
}

/// 1 回の起動で決まる値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub(crate) executable_path: String,
    pub(crate) model_path: String,
    pub(crate) context_size: u32,
    pub(crate) port: u16,
}

/// 状態と起動の通し番号。
#[derive(Debug)]
pub(crate) struct StatusMachine {
    run_id: u64,
    status: LlamaServerStatus,
    launch: Option<Launch>,
}

impl StatusMachine {
    pub(crate) fn new() -> Self {
        Self {
            run_id: 0,
            status: LlamaServerStatus::Stopped {
                run_id: 0,
                cause: StopCause::Initial,
                exit_code: None,
            },
            launch: None,
        }
    }

    pub(crate) fn run_id(&self) -> u64 {
        self.run_id
    }

    pub(crate) fn status(&self) -> &LlamaServerStatus {
        &self.status
    }

    /// 起動を始めた。通し番号を 1 増やして読み込み中にし、新しい通し番号を返す。
    ///
    /// どの状態からでも呼べる。前の起動の通知は、通し番号が合わなくなるので
    /// 状態を書き換えない。
    pub(crate) fn begin_start(&mut self, launch: Launch) -> u64 {
        self.run_id += 1;
        self.status = LlamaServerStatus::Loading {
            run_id: self.run_id,
            model_path: launch.model_path.clone(),
            context_size: launch.context_size,
            port: launch.port,
        };
        self.launch = Some(launch);
        self.run_id
    }

    /// 起動できなかった。状態が変わったら `true`。
    pub(crate) fn spawn_failed(&mut self, run_id: u64, message: String) -> bool {
        self.fail_loading(run_id, FailureReason::Spawn, message, None)
    }

    /// `/health` が 200 を返した。状態が変わったら `true`。
    pub(crate) fn mark_ready(&mut self, run_id: u64) -> bool {
        if run_id != self.run_id {
            return false;
        }
        let LlamaServerStatus::Loading {
            model_path,
            context_size,
            port,
            ..
        } = &self.status
        else {
            return false;
        };
        self.status = LlamaServerStatus::Ready {
            run_id,
            model_path: model_path.clone(),
            context_size: *context_size,
            port: *port,
        };
        true
    }

    /// プロセスが終了した。状態が変わったら `true`。
    ///
    /// 読み込み中の終了は失敗、準備完了のあとの終了は「停止中(終了した)」
    /// (Req 5.6, 5.11)。
    pub(crate) fn process_exited(&mut self, run_id: u64, exit_code: Option<i32>) -> bool {
        if run_id != self.run_id {
            return false;
        }
        match self.status {
            LlamaServerStatus::Loading { .. } => {
                self.fail_loading(run_id, FailureReason::Exited, String::new(), exit_code)
            }
            LlamaServerStatus::Ready { .. } => {
                self.status = LlamaServerStatus::Stopped {
                    run_id,
                    cause: StopCause::Exited,
                    exit_code,
                };
                true
            }
            LlamaServerStatus::Stopped { .. } | LlamaServerStatus::Failed { .. } => false,
        }
    }

    /// 停止した。状態が変わったら `true`。
    ///
    /// 通し番号を進めるのは、止めたプロセスの見張りと待ちが、このあと届ける通知で
    /// 状態を書き換えないようにするため。読み込み中でも準備完了でもなければ、
    /// 何も変えない(停止は冪等)。
    pub(crate) fn mark_stopped(&mut self) -> bool {
        if !matches!(
            self.status,
            LlamaServerStatus::Loading { .. } | LlamaServerStatus::Ready { .. }
        ) {
            return false;
        }
        self.run_id += 1;
        self.status = LlamaServerStatus::Stopped {
            run_id: self.run_id,
            cause: StopCause::Requested,
            exit_code: None,
        };
        true
    }

    fn fail_loading(
        &mut self,
        run_id: u64,
        reason: FailureReason,
        message: String,
        exit_code: Option<i32>,
    ) -> bool {
        if run_id != self.run_id || !matches!(self.status, LlamaServerStatus::Loading { .. }) {
            return false;
        }
        // 読み込み中なら `begin_start` を通っているので、`launch` は必ずある。
        let Some(launch) = &self.launch else {
            return false;
        };
        self.status = LlamaServerStatus::Failed {
            run_id,
            reason,
            executable_path: launch.executable_path.clone(),
            model_path: launch.model_path.clone(),
            message,
            exit_code,
        };
        true
    }
}

/// `/health` を呼ぶ間隔。
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// `/health` の 1 回の要求の上限。応答を返さない相手で待ちが止まったままになると、
/// 起動し直したあとも古い待ちのスレッドが残るので、要求ごとに区切る。準備完了の
/// 待ち全体には上限を設けない。
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// プロセスの終了を確かめる間隔。
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 起動の要求。`start_llama_server` の引数になる。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartRequest {
    pub(crate) executable_path: String,
    pub(crate) model_path: String,
    pub(crate) context_size: u32,
    pub(crate) extra_args: Vec<String>,
}

/// 状態の送り先。状態が変わるたびに、新しい状態を 1 回受け取る。
pub(crate) type StatusSink = Arc<dyn Fn(LlamaServerStatus) + Send + Sync>;

type SharedChild = Arc<Mutex<Child>>;
type HealthUrlFn = Box<dyn Fn(u16) -> String + Send + Sync>;
type ArgsFn = Box<dyn Fn(&StartRequest, u16) -> Vec<String> + Send + Sync>;

/// ロックを取る。守っている値は、途中で panic しても壊れた状態にならないものだけ
/// なので、poison は無視して使い続ける。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn default_health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/health")
}

/// 空きポートを 1 つ選ぶ。待ち受けは、番号を得たらすぐ閉じる。
fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// `/health` 用の HTTP クライアント。
///
/// 相手は必ず `127.0.0.1` なので、OS のプロキシ設定は使わない(プロキシ経由だと
/// 届かない)。
fn health_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(HEALTH_REQUEST_TIMEOUT)
                .build()
                .ok()
        })
        .as_ref()
}

/// `/health` が 200 を返したか。接続の失敗と 200 以外は、どちらも「まだ」。
fn health_is_ok(url: &str) -> bool {
    let Some(client) = health_client() else {
        return false;
    };
    async_runtime::block_on(async {
        matches!(
            client.get(url).send().await,
            Ok(response) if response.status() == StatusCode::OK
        )
    })
}

/// 実行ファイルを起動する。引数は配列のまま渡し、シェルを通さない。
fn spawn_child(executable_path: &str, args: &[String]) -> io::Result<Child> {
    let mut command = Command::new(executable_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// 強制終了して、終了を待つ。もう終了していれば何も起きない。
fn kill_and_wait(child: &SharedChild) {
    let mut child = lock(child);
    let _ = child.kill();
    let _ = child.wait();
}

/// 起動した子プロセスを入れておくジョブオブジェクト(Windows)。
///
/// ハンドルが閉じると、OS が中のプロセスを終了させる。Sumire が強制終了や異常終了で
/// 終わって停止の処理が走らなくても、`llama-server` を残さないため(Req 6.2)。
/// ハンドルは drop で閉じるので、監督と同じ寿命で持ち続ける。
#[cfg(windows)]
struct ChildJob(Option<win32job::Job>);

#[cfg(windows)]
impl ChildJob {
    /// 作れなくても起動は続けられるよう、失敗は動作ログに残すだけにする。その場合、
    /// 残さない手立ては通常の終了時の停止だけになる。
    fn new() -> Self {
        let mut limits = win32job::ExtendedLimitInfo::new();
        limits.limit_kill_on_job_close();
        match win32job::Job::create_with_limit_info(&limits) {
            Ok(job) => Self(Some(job)),
            Err(e) => {
                eprintln!("[llama-server] ジョブオブジェクトを作れませんでした: {e}");
                Self(None)
            }
        }
    }

    /// 子プロセスをジョブに入れる。入れられなくても、起動は続ける。
    fn assign(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        let Some(job) = &self.0 else {
            return;
        };
        if let Err(e) = job.assign_process(child.as_raw_handle() as isize) {
            eprintln!(
                "[llama-server] 子プロセスをジョブオブジェクトに割り当てられませんでした: {e}"
            );
        }
    }
}

#[cfg(not(windows))]
struct ChildJob;

#[cfg(not(windows))]
impl ChildJob {
    fn new() -> Self {
        Self
    }

    fn assign(&self, _child: &Child) {}
}

/// 出力を行ごとに末尾へ入れる。出力が閉じるまで戻らない。
///
/// `llama-server` の出力に UTF-8 でないバイト(パスの文字コードなど)が混ざっても
/// 読み続けられるよう、行はバイト列で読んでから文字に直す。
fn read_lines_into(stream: impl Read, log: &Mutex<LogTail>) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.last() == Some(&b'\n') {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        lock(log).push(String::from_utf8_lossy(&line).into_owned());
    }
}

fn spawn_log_reader(stream: impl Read + Send + 'static, log: Arc<Mutex<LogTail>>) {
    std::thread::spawn(move || read_lines_into(stream, &log));
}

struct Inner {
    machine: StatusMachine,
    child: Option<SharedChild>,
    log: Arc<Mutex<LogTail>>,
}

/// 監督と、起動ごとのスレッド(待ち・見張り)が共有する部分。
struct Shared {
    inner: Mutex<Inner>,
    /// 状態の書き換えと、その状態を送り先に渡すまでを 1 つにまとめるロック。
    ///
    /// 送り先は `inner` のロックの外で呼ぶ。それだけだと、待ちの「準備完了」と
    /// 見張りの「終了した」が続けて起きたとき、送る順が入れ替わりうる。
    /// `inner` より先にこのロックを取ることで、書き換えた順に送る。
    notify: Mutex<()>,
}

impl Shared {
    /// 状態を書き換え、変わっていたら送り先に渡す。書き換えたあとの状態を返す。
    fn transition(
        &self,
        sink: &StatusSink,
        change: impl FnOnce(&mut Inner) -> bool,
    ) -> LlamaServerStatus {
        let _order = lock(&self.notify);
        let (changed, status) = {
            let mut inner = lock(&self.inner);
            let changed = change(&mut inner);
            (changed, inner.machine.status().clone())
        };
        if changed {
            sink(status.clone());
        }
        status
    }

    fn is_loading(&self, run_id: u64) -> bool {
        let inner = lock(&self.inner);
        inner.machine.run_id() == run_id
            && matches!(inner.machine.status(), LlamaServerStatus::Loading { .. })
    }
}

/// `/health` が 200 を返すまで待ち、準備完了にする。
///
/// 読み込み中でなくなったら(準備完了、プロセスの終了、停止、起動し直し)やめる。
/// 準備完了のあとは通信しない(Req 5.10)。
fn wait_until_ready(shared: &Shared, run_id: u64, url: &str, sink: &StatusSink) {
    while shared.is_loading(run_id) {
        if health_is_ok(url) {
            shared.transition(sink, |inner| inner.machine.mark_ready(run_id));
            return;
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
}

/// プロセスの終了を見張り、終了を状態機械に知らせる。
///
/// 停止と起動し直しは、通し番号を進めてからプロセスを強制終了する。その終了は、
/// ここで見つけても通し番号が合わないので、状態を書き換えない。
fn watch_exit(shared: &Shared, run_id: u64, child: &SharedChild, sink: &StatusSink) {
    loop {
        let exit_code = match lock(child).try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some(status.code()),
            // 終了を確かめられないプロセスは、もう見張れない。終了として扱う。
            Err(_) => Some(None),
        };
        if let Some(exit_code) = exit_code {
            shared.transition(sink, |inner| {
                inner.machine.process_exited(run_id, exit_code)
            });
            return;
        }
        std::thread::sleep(EXIT_POLL_INTERVAL);
    }
}

/// `llama-server` を 1 つだけ起動し、状態と出力の末尾を持つ。
pub(crate) struct Supervisor {
    shared: Arc<Shared>,
    /// 起動と停止を 1 つずつ通すロック。動かすプロセスを 1 つに保つ(Req 3.6)。
    /// プロセスの強制終了と待ちの間も持つので、`inner` とは分ける(その間も状態を
    /// 読めるようにするため)。
    lifecycle: Mutex<()>,
    health_url: HealthUrlFn,
    args: ArgsFn,
    job: ChildJob,
}

impl Supervisor {
    pub(crate) fn new() -> Self {
        Self::with_health_url(default_health_url)
    }

    /// `/health` の URL の組み立てを差し替えた監督を作る(試験用の差し替え口)。
    pub(crate) fn with_health_url(
        health_url: impl Fn(u16) -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    machine: StatusMachine::new(),
                    child: None,
                    log: Arc::default(),
                }),
                notify: Mutex::new(()),
            }),
            lifecycle: Mutex::new(()),
            health_url: Box::new(health_url),
            args: Box::new(|req, port| {
                build_args(&req.model_path, req.context_size, port, &req.extra_args)
            }),
            job: ChildJob::new(),
        }
    }

    /// 起動する。動いているプロセスがあれば、先に止める。
    ///
    /// 読み込み中(起動できた)か、失敗(起動できなかった)を返す。準備完了と
    /// プロセスの終了は、あとから `sink` に届く。
    pub(crate) fn start(&self, req: StartRequest, sink: StatusSink) -> LlamaServerStatus {
        let _lifecycle = lock(&self.lifecycle);

        let (port, port_error) = match free_port() {
            Ok(port) => (port, None),
            Err(e) => (0, Some(e)),
        };

        // 前のプロセスを止める前に通し番号を進める。先に止めると、見張りがその終了を
        // 「終了した」として送ってしまう。`mark_stopped` を挟まないのは、通し番号が
        // 2 進み、間に「停止中」が挟まるため。
        let log = Arc::new(Mutex::new(LogTail::new()));
        let mut previous = None;
        let mut run_id = 0;
        self.shared.transition(&sink, |inner| {
            previous = inner.child.take();
            inner.log = Arc::clone(&log);
            run_id = inner.machine.begin_start(Launch {
                executable_path: req.executable_path.clone(),
                model_path: req.model_path.clone(),
                context_size: req.context_size,
                port,
            });
            true
        });
        if let Some(previous) = previous {
            kill_and_wait(&previous);
        }

        let spawned = match port_error {
            Some(e) => Err(e),
            None => spawn_child(&req.executable_path, &(self.args)(&req, port)),
        };
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                return self.shared.transition(&sink, |inner| {
                    inner.machine.spawn_failed(run_id, e.to_string())
                });
            }
        };
        // `llama-server` は子プロセスを作らないので、起動からここまでの間に、ジョブの
        // 外へ孫プロセスが漏れることは無い。
        self.job.assign(&child);

        // 読まないと `llama-server` が出力で止まるので、どちらも読み続ける。
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, Arc::clone(&log));
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, Arc::clone(&log));
        }

        let child = Arc::new(Mutex::new(child));
        let status = {
            let mut inner = lock(&self.shared.inner);
            inner.child = Some(Arc::clone(&child));
            inner.machine.status().clone()
        };

        {
            let shared = Arc::clone(&self.shared);
            let sink = Arc::clone(&sink);
            let url = (self.health_url)(port);
            std::thread::spawn(move || wait_until_ready(&shared, run_id, &url, &sink));
        }
        {
            let shared = Arc::clone(&self.shared);
            std::thread::spawn(move || watch_exit(&shared, run_id, &child, &sink));
        }

        status
    }

    /// 停止する。動いていなければ、何も変えずに今の状態を返す。
    pub(crate) fn stop(&self, sink: StatusSink) -> LlamaServerStatus {
        let _lifecycle = lock(&self.lifecycle);

        // 起動し直しと同じ理由で、強制終了の前に通し番号を進める。送り先に渡すのは、
        // プロセスが終了してから(受け取った側が、GPU メモリが空いたものとして
        // 扱えるように)。このあいだ通し番号は進んでいて、待ちと見張りは状態を
        // 書き換えないので、送る順は入れ替わらない。
        let (changed, status, child) = {
            let _order = lock(&self.shared.notify);
            let mut inner = lock(&self.shared.inner);
            let changed = inner.machine.mark_stopped();
            (changed, inner.machine.status().clone(), inner.child.take())
        };
        if let Some(child) = child {
            kill_and_wait(&child);
        }
        if changed {
            sink(status.clone());
        }
        status
    }

    pub(crate) fn status(&self) -> LlamaServerStatus {
        lock(&self.shared.inner).machine.status().clone()
    }

    /// 今の(または最後の)起動の、出力の末尾。古い順。
    pub(crate) fn log_lines(&self) -> Vec<String> {
        let log = Arc::clone(&lock(&self.shared.inner).log);
        let lines = lock(&log).lines();
        lines
    }

    #[cfg(test)]
    fn with_args(
        mut self,
        args: impl Fn(&StartRequest, u16) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        self.args = Box::new(args);
        self
    }

    #[cfg(test)]
    fn child(&self) -> Option<SharedChild> {
        lock(&self.shared.inner).child.clone()
    }
}

impl Drop for Supervisor {
    /// 監督が無くなるときに、プロセスを残さない。
    fn drop(&mut self) {
        let child = lock(&self.shared.inner).child.take();
        if let Some(child) = child {
            kill_and_wait(&child);
        }
    }
}

/// コンテキスト長を確かめてから起動する。`start_llama_server` の中身。
///
/// command 本体から分けるのは、Tauri の `AppHandle` が無くても試せるようにするため。
fn start_checked(
    supervisor: &Supervisor,
    req: StartRequest,
    sink: StatusSink,
) -> Result<LlamaServerStatus, String> {
    // 0 を渡すと、`llama-server` はモデルの学習時の長さで読み込み、GPU メモリから
    // あふれうる(Req 4.7)。
    if req.context_size < 1 {
        return Err("コンテキスト長は 1 以上で指定してください".to_string());
    }
    Ok(supervisor.start(req, sink))
}

/// アプリの状態として持つ監督。
///
/// `Arc` で持つのは、起動と停止を別スレッドに渡すため。どちらも強制終了と終了の待ちで
/// 呼び出したスレッドを止める。
pub struct LlamaServerState {
    supervisor: Arc<Supervisor>,
}

impl Default for LlamaServerState {
    fn default() -> Self {
        Self {
            supervisor: Arc::new(Supervisor::new()),
        }
    }
}

impl LlamaServerState {
    /// アプリの終了時に、動いている `llama-server` を止める(Req 6.1)。
    ///
    /// 終了の途中なので、状態は誰にも送らない。
    pub fn shutdown(&self) {
        self.supervisor.stop(Arc::new(|_| {}));
    }
}

/// 状態を全ウィンドウに送る送り先。
///
/// 監督のロックの中から呼ばれるので、イベントを送る以外のことはしない。送れなくても
/// (ウィンドウが閉じたあとなど)監督は止めない。
fn event_sink(app: AppHandle) -> StatusSink {
    Arc::new(move |status| {
        let _ = app.emit(STATUS_EVENT, status);
    })
}

/// 動いているプロセスを止めてから起動する。読み込み中か、失敗(起動できなかった)を
/// 返す。準備完了とプロセスの終了は、あとからイベントで届く。
#[tauri::command]
pub async fn start_llama_server(
    req: StartRequest,
    app: AppHandle,
    state: State<'_, LlamaServerState>,
) -> Result<LlamaServerStatus, String> {
    let supervisor = Arc::clone(&state.supervisor);
    let sink = event_sink(app);
    async_runtime::spawn_blocking(move || start_checked(&supervisor, req, sink))
        .await
        .map_err(|e| e.to_string())?
}

/// 停止する。動いていなければ、今の状態を返す。
///
/// 戻り値が `Result` なのは、借用の引数(`State`)を取る `async` の command の決まり。
/// エラーになるのは、停止のスレッドが panic したときだけ。
#[tauri::command]
pub async fn stop_llama_server(
    app: AppHandle,
    state: State<'_, LlamaServerState>,
) -> Result<LlamaServerStatus, String> {
    let supervisor = Arc::clone(&state.supervisor);
    let sink = event_sink(app);
    async_runtime::spawn_blocking(move || supervisor.stop(sink))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_llama_server_status(state: State<'_, LlamaServerState>) -> LlamaServerStatus {
    state.supervisor.status()
}

/// 今の(または最後の)起動の、出力の末尾。古い順。
#[tauri::command]
pub fn read_llama_server_log(state: State<'_, LlamaServerState>) -> Vec<String> {
    state.supervisor.log_lines()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn launch() -> Launch {
        Launch {
            executable_path: "C:\\llama\\llama-server.exe".to_string(),
            model_path: "D:\\models\\a.gguf".to_string(),
            context_size: 32768,
            port: 51234,
        }
    }

    fn other_launch() -> Launch {
        Launch {
            executable_path: "C:\\llama\\llama-server.exe".to_string(),
            model_path: "D:\\models\\b.gguf".to_string(),
            context_size: 8192,
            port: 51999,
        }
    }

    fn loading(run_id: u64, l: &Launch) -> LlamaServerStatus {
        LlamaServerStatus::Loading {
            run_id,
            model_path: l.model_path.clone(),
            context_size: l.context_size,
            port: l.port,
        }
    }

    fn ready(run_id: u64, l: &Launch) -> LlamaServerStatus {
        LlamaServerStatus::Ready {
            run_id,
            model_path: l.model_path.clone(),
            context_size: l.context_size,
            port: l.port,
        }
    }

    // --- 起動引数 ---

    #[test]
    fn build_args_puts_the_fixed_pairs_in_order() {
        let args = build_args("D:\\models\\a.gguf", 32768, 51234, &[]);
        assert_eq!(
            args,
            vec![
                "--model",
                "D:\\models\\a.gguf",
                "--ctx-size",
                "32768",
                "--host",
                "127.0.0.1",
                "--port",
                "51234",
                "--parallel",
                "1",
            ]
        );
    }

    #[test]
    fn build_args_appends_extra_args_as_given() {
        let extra = vec![
            "--flash-attn".to_string(),
            "on".to_string(),
            "--no-webui".to_string(),
            "--flash-attn".to_string(),
        ];
        let args = build_args("m.gguf", 4096, 8080, &extra);
        assert_eq!(args.len(), 10 + extra.len());
        assert_eq!(&args[10..], extra.as_slice());
    }

    #[test]
    fn build_args_never_adds_fit() {
        let args = build_args("m.gguf", 4096, 8080, &[]);
        assert!(!args.iter().any(|a| a.starts_with("--fit") || a == "-fit"));
    }

    #[test]
    fn build_args_keeps_a_path_with_spaces_as_one_argument() {
        let args = build_args("D:\\my models\\a b.gguf", 4096, 8080, &[]);
        assert_eq!(args[1], "D:\\my models\\a b.gguf");
        assert_eq!(args.len(), 10);
    }

    // --- 出力の末尾 ---

    #[test]
    fn log_tail_starts_empty() {
        assert!(LogTail::new().lines().is_empty());
    }

    #[test]
    fn log_tail_keeps_200_lines_oldest_first() {
        let mut tail = LogTail::new();
        for i in 1..=200 {
            tail.push(format!("line {i}"));
        }
        let lines = tail.lines();
        assert_eq!(lines.len(), 200);
        assert_eq!(lines[0], "line 1");
        assert_eq!(lines[199], "line 200");
    }

    #[test]
    fn log_tail_drops_the_first_line_on_the_201st() {
        let mut tail = LogTail::new();
        for i in 1..=201 {
            tail.push(format!("line {i}"));
        }
        let lines = tail.lines();
        assert_eq!(lines.len(), 200);
        assert_eq!(lines[0], "line 2");
        assert_eq!(lines[199], "line 201");
    }

    // --- 状態の遷移 ---

    #[test]
    fn machine_starts_stopped_initial() {
        let m = StatusMachine::new();
        assert_eq!(m.run_id(), 0);
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Stopped {
                run_id: 0,
                cause: StopCause::Initial,
                exit_code: None,
            }
        );
    }

    #[test]
    fn begin_start_increments_run_id_and_goes_loading() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert_eq!(run_id, 1);
        assert_eq!(m.run_id(), 1);
        assert_eq!(m.status(), &loading(1, &launch()));
    }

    #[test]
    fn mark_ready_moves_loading_to_ready() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_ready(run_id));
        assert_eq!(m.status(), &ready(1, &launch()));
    }

    #[test]
    fn mark_ready_twice_changes_nothing_the_second_time() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_ready(run_id));
        assert!(!m.mark_ready(run_id));
        assert_eq!(m.status(), &ready(1, &launch()));
    }

    #[test]
    fn exit_while_loading_is_a_failure() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.process_exited(run_id, Some(1)));
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Failed {
                run_id: 1,
                reason: FailureReason::Exited,
                executable_path: launch().executable_path,
                model_path: launch().model_path,
                message: String::new(),
                exit_code: Some(1),
            }
        );
    }

    #[test]
    fn exit_after_ready_is_stopped_exited() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_ready(run_id));
        assert!(m.process_exited(run_id, Some(0)));
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Stopped {
                run_id: 1,
                cause: StopCause::Exited,
                exit_code: Some(0),
            }
        );
    }

    #[test]
    fn exit_without_a_code_keeps_null() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_ready(run_id));
        assert!(m.process_exited(run_id, None));
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Stopped {
                run_id: 1,
                cause: StopCause::Exited,
                exit_code: None,
            }
        );
    }

    #[test]
    fn spawn_failure_is_failed_spawn() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.spawn_failed(run_id, "not found".to_string()));
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Failed {
                run_id: 1,
                reason: FailureReason::Spawn,
                executable_path: launch().executable_path,
                model_path: launch().model_path,
                message: "not found".to_string(),
                exit_code: None,
            }
        );
    }

    #[test]
    fn stale_ready_does_not_change_the_status() {
        let mut m = StatusMachine::new();
        let old = m.begin_start(launch());
        let _new = m.begin_start(other_launch());
        assert!(!m.mark_ready(old));
        assert_eq!(m.status(), &loading(2, &other_launch()));
    }

    #[test]
    fn stale_exit_does_not_change_the_status() {
        let mut m = StatusMachine::new();
        let old = m.begin_start(launch());
        let new = m.begin_start(other_launch());
        assert!(!m.process_exited(old, Some(1)));
        assert_eq!(m.status(), &loading(2, &other_launch()));

        assert!(m.mark_ready(new));
        assert!(!m.process_exited(old, Some(1)));
        assert_eq!(m.status(), &ready(2, &other_launch()));
    }

    #[test]
    fn stale_spawn_failure_does_not_change_the_status() {
        let mut m = StatusMachine::new();
        let old = m.begin_start(launch());
        let _new = m.begin_start(other_launch());
        assert!(!m.spawn_failed(old, "not found".to_string()));
        assert_eq!(m.status(), &loading(2, &other_launch()));
    }

    #[test]
    fn stop_advances_run_id_and_goes_stopped_requested() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_ready(run_id));
        assert!(m.mark_stopped());
        assert_eq!(m.run_id(), 2);
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Stopped {
                run_id: 2,
                cause: StopCause::Requested,
                exit_code: None,
            }
        );
    }

    #[test]
    fn stop_while_loading_goes_stopped_requested() {
        let mut m = StatusMachine::new();
        m.begin_start(launch());
        assert!(m.mark_stopped());
        assert_eq!(
            m.status(),
            &LlamaServerStatus::Stopped {
                run_id: 2,
                cause: StopCause::Requested,
                exit_code: None,
            }
        );
    }

    #[test]
    fn notifications_for_a_stopped_run_do_not_change_the_status() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.mark_stopped());
        let stopped = m.status().clone();
        assert!(!m.mark_ready(run_id));
        assert!(!m.process_exited(run_id, Some(1)));
        assert_eq!(m.status(), &stopped);
    }

    #[test]
    fn stop_when_nothing_is_running_changes_nothing() {
        let mut m = StatusMachine::new();
        assert!(!m.mark_stopped());
        assert_eq!(m.run_id(), 0);

        let run_id = m.begin_start(launch());
        assert!(m.process_exited(run_id, Some(1)));
        let failed = m.status().clone();
        assert!(!m.mark_stopped());
        assert_eq!(m.run_id(), 1);
        assert_eq!(m.status(), &failed);
    }

    #[test]
    fn start_after_a_failure_or_a_stop_goes_loading_with_a_new_run_id() {
        let mut m = StatusMachine::new();
        let first = m.begin_start(launch());
        assert!(m.process_exited(first, Some(1)));
        let second = m.begin_start(other_launch());
        assert_eq!(second, 2);
        assert_eq!(m.status(), &loading(2, &other_launch()));

        assert!(m.mark_stopped());
        let third = m.begin_start(launch());
        assert_eq!(third, 4);
        assert_eq!(m.status(), &loading(4, &launch()));
    }

    #[test]
    fn exit_after_a_failure_changes_nothing() {
        let mut m = StatusMachine::new();
        let run_id = m.begin_start(launch());
        assert!(m.spawn_failed(run_id, "not found".to_string()));
        let failed = m.status().clone();
        assert!(!m.process_exited(run_id, Some(1)));
        assert!(!m.mark_ready(run_id));
        assert_eq!(m.status(), &failed);
    }

    // --- 子プロセスの監督 ---
    // 実行ファイルには、すぐ終わるスクリプトと、長く眠るテストバイナリ自身を使う。
    // `/health` には std の TcpListener の待ち受けを使う。待ちはすべて上限付き。

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    /// 状態 1 件・`/health` の要求 1 件を待つ上限。Windows で閉じたポートへの接続が
    /// 拒否されるまで 2 秒ほどかかるので、それより十分長くとる。
    const WAIT: Duration = Duration::from_secs(10);

    /// 「もう来ない」ことを確かめる長さ。`/health` の間隔(0.5 秒)と見張りの間隔
    /// (0.25 秒)の数回分。
    const QUIET: Duration = Duration::from_millis(1500);

    const LONG_LIVED_MARKER: &str = "sumire-llama-server-long-lived-child";

    /// 長く動く子プロセスの中身。`cargo test` で普通に走るときは何もしない。
    ///
    /// OS のコマンドには、`--model` などの引数と空の標準入力を渡されても、孫プロセスも
    /// ダイアログも作らずに動き続けるものが無かった。そこで、テストバイナリ自身に
    /// このテストだけを実行させて、長命のプロセスにする。
    #[test]
    fn long_lived_child() {
        if std::env::args().any(|arg| arg == LONG_LIVED_MARKER) {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    fn long_lived_args(_req: &StartRequest, _port: u16) -> Vec<String> {
        vec![
            "--exact".to_string(),
            "commands::llama_server::tests::long_lived_child".to_string(),
            LONG_LIVED_MARKER.to_string(),
        ]
    }

    fn long_lived_request() -> StartRequest {
        StartRequest {
            executable_path: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            model_path: "m.gguf".to_string(),
            context_size: 4096,
            extra_args: Vec::new(),
        }
    }

    /// テストごとの一時フォルダ。drop で消す。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "sumire-llama-server-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 引数を無視し、標準エラーに `boom` と書いて、終了コード 3 で終わるスクリプト。
    #[cfg(windows)]
    fn short_lived_script(dir: &TempDir) -> String {
        let path = dir.0.join("exit3.bat");
        std::fs::write(&path, "@echo boom 1>&2\r\n@exit 3\r\n").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(not(windows))]
    fn short_lived_script(dir: &TempDir) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.0.join("exit3.sh");
        std::fs::write(&path, "#!/bin/sh\necho boom >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn collector() -> (StatusSink, mpsc::Receiver<LlamaServerStatus>) {
        let (tx, rx) = mpsc::channel();
        let sink: StatusSink = Arc::new(move |status| {
            let _ = tx.send(status);
        });
        (sink, rx)
    }

    fn next_status(rx: &mpsc::Receiver<LlamaServerStatus>) -> LlamaServerStatus {
        rx.recv_timeout(WAIT)
            .expect("status did not arrive in time")
    }

    /// しばらく何も届かないことを確かめる。送り手がすべて無くなった(もう届き
    /// ようがない)場合も、届かなかったものとして通す。
    fn assert_quiet<T: std::fmt::Debug>(rx: &mpsc::Receiver<T>) {
        if let Ok(unexpected) = rx.recv_timeout(QUIET) {
            panic!("expected nothing, got {unexpected:?}");
        }
    }

    fn wait_until(mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        cond()
    }

    fn has_exited(child: &SharedChild) -> bool {
        matches!(lock(child).try_wait(), Ok(Some(_)))
    }

    /// `/health` の待ち受け。要求のたびに、返すステータスを `requests` に送ってから
    /// 応答する。`script` を使い切ったあとは 200 を返す。
    struct HealthServer {
        url: String,
        requests: mpsc::Receiver<u16>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for HealthServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn serve_health(script: Vec<u16>) -> HealthServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/health", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (tx, requests) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = std::thread::spawn(move || {
            let mut script = script.into_iter();
            while !stopped.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(WAIT)).unwrap();
                let mut head = Vec::new();
                let mut buf = [0u8; 512];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                }
                assert!(head.starts_with(b"GET /health HTTP/1.1\r\n"));
                let status = script.next().unwrap_or(200);
                let _ = tx.send(status);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
            }
        });
        HealthServer {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    /// 長命の子プロセスを起動し、`/health` を `server` に向ける監督。
    fn long_lived_supervisor(server: &HealthServer) -> Supervisor {
        let url = server.url.clone();
        Supervisor::with_health_url(move |_port| url.clone()).with_args(long_lived_args)
    }

    #[test]
    fn start_request_deserializes_from_camel_case_json() {
        let req: StartRequest = serde_json::from_value(json!({
            "executablePath": "C:\\llama\\llama-server.exe",
            "modelPath": "D:\\models\\a.gguf",
            "contextSize": 32768,
            "extraArgs": ["--flash-attn", "on"],
        }))
        .unwrap();
        assert_eq!(req.executable_path, "C:\\llama\\llama-server.exe");
        assert_eq!(req.model_path, "D:\\models\\a.gguf");
        assert_eq!(req.context_size, 32768);
        assert_eq!(req.extra_args, vec!["--flash-attn", "on"]);
    }

    #[test]
    fn default_health_url_points_at_the_loopback_port() {
        assert_eq!(default_health_url(51234), "http://127.0.0.1:51234/health");
    }

    #[test]
    fn free_port_returns_a_port_that_can_be_bound() {
        let port = free_port().unwrap();
        assert_ne!(port, 0);
        TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[test]
    fn log_reader_splits_lines_and_replaces_invalid_utf8() {
        let log = Mutex::new(LogTail::new());
        read_lines_into(&b"one\r\n\xff\xfetwo\n\nlast"[..], &log);
        assert_eq!(
            lock(&log).lines(),
            vec!["one", "\u{fffd}\u{fffd}two", "", "last"]
        );
    }

    #[test]
    fn a_new_supervisor_is_stopped_and_stop_changes_nothing() {
        let supervisor = Supervisor::new();
        let initial = StatusMachine::new().status().clone();
        assert_eq!(supervisor.status(), initial);
        assert!(supervisor.log_lines().is_empty());

        let (sink, events) = collector();
        assert_eq!(supervisor.stop(sink), initial);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn a_command_that_exits_at_once_fails_with_its_exit_code() {
        let dir = TempDir::new();
        let executable_path = short_lived_script(&dir);
        let supervisor = Supervisor::new();
        let (sink, events) = collector();

        let returned = supervisor.start(
            StartRequest {
                executable_path: executable_path.clone(),
                model_path: "m.gguf".to_string(),
                context_size: 4096,
                extra_args: vec!["--no-webui".to_string()],
            },
            sink,
        );

        let LlamaServerStatus::Loading {
            run_id: 1,
            ref model_path,
            context_size: 4096,
            port,
        } = returned
        else {
            panic!("expected loading, got {returned:?}");
        };
        assert_eq!(model_path, "m.gguf");
        assert_ne!(port, 0);
        assert_eq!(next_status(&events), returned);

        let failed = LlamaServerStatus::Failed {
            run_id: 1,
            reason: FailureReason::Exited,
            executable_path,
            model_path: "m.gguf".to_string(),
            message: String::new(),
            exit_code: Some(3),
        };
        assert_eq!(next_status(&events), failed);
        assert_eq!(supervisor.status(), failed);
        assert!(
            wait_until(|| supervisor.log_lines().iter().any(|l| l.contains("boom"))),
            "log: {:?}",
            supervisor.log_lines()
        );
    }

    #[test]
    fn a_missing_executable_fails_to_spawn() {
        let dir = TempDir::new();
        let executable_path = dir
            .0
            .join("no-such-llama-server.exe")
            .to_string_lossy()
            .into_owned();
        let supervisor = Supervisor::new();
        let (sink, events) = collector();

        let returned = supervisor.start(
            StartRequest {
                executable_path: executable_path.clone(),
                model_path: "m.gguf".to_string(),
                context_size: 4096,
                extra_args: Vec::new(),
            },
            sink,
        );

        let LlamaServerStatus::Failed {
            run_id: 1,
            reason: FailureReason::Spawn,
            executable_path: ref failed_path,
            ref model_path,
            ref message,
            exit_code: None,
        } = returned
        else {
            panic!("expected failed (spawn), got {returned:?}");
        };
        assert_eq!(failed_path, &executable_path);
        assert_eq!(model_path, "m.gguf");
        assert!(!message.is_empty());

        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Loading { run_id: 1, .. }
        ));
        assert_eq!(next_status(&events), returned);
        assert_eq!(supervisor.status(), returned);
        assert!(supervisor.child().is_none());
    }

    #[test]
    fn health_200_makes_it_ready_and_then_nothing_more_is_requested() {
        let server = serve_health(vec![503]);
        let asked_ports = Arc::new(Mutex::new(Vec::new()));
        let supervisor = {
            let url = server.url.clone();
            let asked_ports = Arc::clone(&asked_ports);
            Supervisor::with_health_url(move |port| {
                lock(&asked_ports).push(port);
                url.clone()
            })
            .with_args(long_lived_args)
        };
        let (sink, events) = collector();

        let returned = supervisor.start(long_lived_request(), sink);
        let LlamaServerStatus::Loading {
            run_id: 1, port, ..
        } = returned
        else {
            panic!("expected loading, got {returned:?}");
        };
        assert_eq!(*lock(&asked_ports), vec![port]);
        assert_eq!(next_status(&events), returned);

        // 503 は「まだ」。次の 200 で準備完了になる。
        assert_eq!(server.requests.recv_timeout(WAIT), Ok(503));
        assert_eq!(server.requests.recv_timeout(WAIT), Ok(200));
        let ready = LlamaServerStatus::Ready {
            run_id: 1,
            model_path: "m.gguf".to_string(),
            context_size: 4096,
            port,
        };
        assert_eq!(next_status(&events), ready);
        assert_eq!(supervisor.status(), ready);

        assert_quiet(&server.requests);
        assert_quiet(&events);
        assert!(
            wait_until(|| supervisor
                .log_lines()
                .iter()
                .any(|l| l.contains("running 1 test"))),
            "log: {:?}",
            supervisor.log_lines()
        );
    }

    #[test]
    fn stop_after_ready_kills_the_process_and_is_idempotent() {
        let server = serve_health(Vec::new());
        let supervisor = long_lived_supervisor(&server);
        let (sink, events) = collector();

        supervisor.start(long_lived_request(), Arc::clone(&sink));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Loading { run_id: 1, .. }
        ));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Ready { run_id: 1, .. }
        ));
        let child = supervisor.child().expect("child");
        assert!(!has_exited(&child));

        let stopped = LlamaServerStatus::Stopped {
            run_id: 2,
            cause: StopCause::Requested,
            exit_code: None,
        };
        assert_eq!(supervisor.stop(Arc::clone(&sink)), stopped);
        assert!(has_exited(&child));
        assert!(supervisor.child().is_none());
        assert_eq!(next_status(&events), stopped);

        assert_eq!(supervisor.stop(sink), stopped);
        // 止めたプロセスの見張りが、終了を「終了した」として送ってこない。
        assert_quiet(&events);
        assert_eq!(supervisor.status(), stopped);
    }

    #[test]
    fn stop_while_loading_does_not_report_a_failure() {
        // 何も返さない待ち受け: 接続は成立するが応答が来ないので、読み込み中のまま。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/health", listener.local_addr().unwrap());
        let supervisor =
            Supervisor::with_health_url(move |_port| url.clone()).with_args(long_lived_args);
        let (sink, events) = collector();

        supervisor.start(long_lived_request(), Arc::clone(&sink));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Loading { run_id: 1, .. }
        ));
        let child = supervisor.child().expect("child");

        let stopped = supervisor.stop(sink);
        assert_eq!(
            stopped,
            LlamaServerStatus::Stopped {
                run_id: 2,
                cause: StopCause::Requested,
                exit_code: None,
            }
        );
        assert!(has_exited(&child));
        assert_eq!(next_status(&events), stopped);
        assert_quiet(&events);
        assert_eq!(supervisor.status(), stopped);
        drop(listener);
    }

    #[test]
    fn starting_again_ends_the_previous_process_first() {
        let server = serve_health(Vec::new());
        let supervisor = long_lived_supervisor(&server);
        let (sink, events) = collector();

        supervisor.start(long_lived_request(), Arc::clone(&sink));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Loading { run_id: 1, .. }
        ));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Ready { run_id: 1, .. }
        ));
        let first = supervisor.child().expect("first child");
        let first_pid = lock(&first).id();
        assert!(wait_until(|| !supervisor.log_lines().is_empty()));

        let mut second_request = long_lived_request();
        second_request.model_path = "other.gguf".to_string();
        let returned = supervisor.start(second_request, Arc::clone(&sink));
        assert!(has_exited(&first));
        let second = supervisor.child().expect("second child");
        assert_ne!(lock(&second).id(), first_pid);
        assert!(!has_exited(&second));

        // 間に「停止中」を挟まず、通し番号が 1 だけ進む。
        let LlamaServerStatus::Loading {
            run_id: 2,
            ref model_path,
            ..
        } = returned
        else {
            panic!("expected loading, got {returned:?}");
        };
        assert_eq!(model_path, "other.gguf");
        assert_eq!(next_status(&events), returned);
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Ready { run_id: 2, .. }
        ));
        assert_quiet(&events);

        supervisor.stop(sink);
        assert!(has_exited(&second));
    }

    #[test]
    fn dropping_the_supervisor_ends_the_process() {
        let server = serve_health(Vec::new());
        let supervisor = long_lived_supervisor(&server);
        let (sink, _events) = collector();
        supervisor.start(long_lived_request(), sink);
        let child = supervisor.child().expect("child");
        drop(supervisor);
        assert!(has_exited(&child));
    }

    // --- command の中身 ---

    #[test]
    fn a_start_request_with_context_size_0_is_an_error_and_starts_nothing() {
        let server = serve_health(Vec::new());
        let supervisor = long_lived_supervisor(&server);
        let initial = supervisor.status();
        let (sink, events) = collector();

        let mut req = long_lived_request();
        req.context_size = 0;
        let result = start_checked(&supervisor, req, sink);

        assert!(result.is_err(), "expected an error, got {result:?}");
        assert!(supervisor.child().is_none());
        assert_eq!(supervisor.status(), initial);
        assert!(events.try_recv().is_err());
        assert_quiet(&server.requests);
    }

    #[test]
    fn a_start_request_with_context_size_1_starts() {
        let server = serve_health(Vec::new());
        let supervisor = long_lived_supervisor(&server);
        let (sink, _events) = collector();

        let mut req = long_lived_request();
        req.context_size = 1;
        let result = start_checked(&supervisor, req, sink);

        assert!(matches!(
            result,
            Ok(LlamaServerStatus::Loading {
                run_id: 1,
                context_size: 1,
                ..
            })
        ));
        assert!(supervisor.child().is_some());
    }

    // --- ジョブオブジェクト(Windows) ---

    #[cfg(windows)]
    #[test]
    fn closing_the_job_ends_a_process_assigned_to_it() {
        let req = long_lived_request();
        let mut child = spawn_child(&req.executable_path, &long_lived_args(&req, 0)).unwrap();
        let job = ChildJob::new();
        let created = job.0.is_some();
        job.assign(&child);
        let alive_in_the_job = matches!(child.try_wait(), Ok(None));

        drop(job);
        let exited = wait_until(|| matches!(child.try_wait(), Ok(Some(_))));
        // 落ちるときも、子プロセスを残さない。
        let _ = child.kill();
        let _ = child.wait();
        assert!(created, "the job was not created");
        assert!(
            alive_in_the_job,
            "the process ended before the job was closed"
        );
        assert!(exited, "the process outlived the job");
    }

    #[cfg(windows)]
    #[test]
    fn a_started_process_is_in_the_supervisors_job() {
        let server = serve_health(Vec::new());
        let mut supervisor = long_lived_supervisor(&server);
        let (sink, events) = collector();

        supervisor.start(long_lived_request(), sink);
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Loading { run_id: 1, .. }
        ));
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Ready { run_id: 1, .. }
        ));
        let child = supervisor.child().expect("child");

        // 停止を呼ばずに、ジョブだけを閉じる。
        supervisor.job = ChildJob(None);
        assert!(
            wait_until(|| has_exited(&child)),
            "the process outlived the job"
        );
        assert!(matches!(
            next_status(&events),
            LlamaServerStatus::Stopped {
                run_id: 1,
                cause: StopCause::Exited,
                ..
            }
        ));
    }

    // --- JSON の形 ---

    #[test]
    fn stopped_serializes_like_the_frontend_type() {
        let initial = serde_json::to_value(StatusMachine::new().status()).unwrap();
        assert_eq!(
            initial,
            json!({ "state": "stopped", "runId": 0, "cause": "initial", "exitCode": null })
        );

        let requested = serde_json::to_value(LlamaServerStatus::Stopped {
            run_id: 3,
            cause: StopCause::Requested,
            exit_code: None,
        })
        .unwrap();
        assert_eq!(
            requested,
            json!({ "state": "stopped", "runId": 3, "cause": "requested", "exitCode": null })
        );

        let exited = serde_json::to_value(LlamaServerStatus::Stopped {
            run_id: 3,
            cause: StopCause::Exited,
            exit_code: Some(-1),
        })
        .unwrap();
        assert_eq!(
            exited,
            json!({ "state": "stopped", "runId": 3, "cause": "exited", "exitCode": -1 })
        );
    }

    #[test]
    fn loading_and_ready_serialize_like_the_frontend_type() {
        assert_eq!(
            serde_json::to_value(loading(1, &launch())).unwrap(),
            json!({
                "state": "loading",
                "runId": 1,
                "modelPath": "D:\\models\\a.gguf",
                "contextSize": 32768,
                "port": 51234,
            })
        );
        assert_eq!(
            serde_json::to_value(ready(1, &launch())).unwrap(),
            json!({
                "state": "ready",
                "runId": 1,
                "modelPath": "D:\\models\\a.gguf",
                "contextSize": 32768,
                "port": 51234,
            })
        );
    }

    #[test]
    fn failed_serializes_like_the_frontend_type() {
        let spawn = serde_json::to_value(LlamaServerStatus::Failed {
            run_id: 2,
            reason: FailureReason::Spawn,
            executable_path: "C:\\llama\\llama-server.exe".to_string(),
            model_path: "D:\\models\\a.gguf".to_string(),
            message: "not found".to_string(),
            exit_code: None,
        })
        .unwrap();
        assert_eq!(
            spawn,
            json!({
                "state": "failed",
                "runId": 2,
                "reason": "spawn",
                "executablePath": "C:\\llama\\llama-server.exe",
                "modelPath": "D:\\models\\a.gguf",
                "message": "not found",
                "exitCode": null,
            })
        );

        let exited = serde_json::to_value(LlamaServerStatus::Failed {
            run_id: 2,
            reason: FailureReason::Exited,
            executable_path: "C:\\llama\\llama-server.exe".to_string(),
            model_path: "D:\\models\\a.gguf".to_string(),
            message: String::new(),
            exit_code: Some(1),
        })
        .unwrap();
        assert_eq!(
            exited,
            json!({
                "state": "failed",
                "runId": 2,
                "reason": "exited",
                "executablePath": "C:\\llama\\llama-server.exe",
                "modelPath": "D:\\models\\a.gguf",
                "message": "",
                "exitCode": 1,
            })
        );
    }
}
