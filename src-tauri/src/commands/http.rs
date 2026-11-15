// プロバイダ(推論サーバー / クラウド AI)への HTTP 通信を Rust 側で中継する
// Tauri commands(provider-http-rust)。
//
// 責務は「送る・流す・切る・キーを付ける」の 4 つに絞る:
// - 画面側から受け取ったリクエストを reqwest で送り、応答開始(ステータス)・
//   本文チャンク・終了 / エラーを Channel で順に流す。
// - 中断の指示で送信タスクを止め、接続を切る。
// - プロバイダ名の指定があるときだけ、keychain から読んだキーで Authorization を
//   付ける(キーの値を画面側に返す経路は持たない)。
// タイムアウト・SSE の解釈・ステータスの分類は画面側のアダプタが担い、ここには
// 持たせない。
//
// 開始時の検証(URL のスキーム、認証方式、キーの有無)は送信タスクを起動する前に
// `prepare_request` でまとめて行い、失敗したら HTTP は一切送らない(Req 2.3, 7.4)。
// キーの読み出しは引数で注入する。本番では `secrets::read_secret` を渡し、
// 単体テストでは実 keychain に触れない差し替え関数を渡す。
//
// command 本体(`http_request` / `http_cancel`)は薄く保ち、処理は「イベントの
// 送り先」と「管理表」を引数に取る `start_request` / `cancel_request` に寄せる。
// Tauri の State / Channel が無くても、テストから直接呼べるようにするため。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tauri::async_runtime;
use tauri::ipc::Channel;
use tauri::State;

use super::secrets;

/// 画面側から指定できる HTTP メソッド。プロバイダ通信で使うものだけに絞る。
#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    fn to_reqwest(&self) -> Method {
        match self {
            HttpMethod::Get => Method::GET,
            HttpMethod::Post => Method::POST,
        }
    }
}

/// 画面側(`nativeFetch`)から受け取るリクエスト。
///
/// `headers` に含まれる Authorization は大文字小文字を問わず送信前に取り除く。
/// 認証情報の付与元は `auth_provider` 経由の Rust 側だけに限る(Req 7.2)。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    /// 例: `"openai"`。指定時のみ、そのプロバイダの保存済みキーを付与する。
    pub auth_provider: Option<String>,
}

/// `http_request` の開始時エラー。どれも HTTP を送る前に判定する。
///
/// 文言にキーの値は含めない(Security Considerations)。画面側では
/// `NativeHttpError` の kind に写され、どれも `config` の ProviderError になる。
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum HttpStartError {
    /// スキームが http / https 以外、または URL として解釈できない。
    InvalidUrl(String),
    /// `auth_provider` のキーが未設定。
    MissingSecret(String),
    /// keychain の読み出し失敗。
    SecretUnavailable(String),
    /// `auth_provider` に対応する認証方式が未定義。
    UnsupportedAuth(String),
    /// 呼び出し側のヘッダー名・値が HTTP ヘッダーとして不正。文言はヘッダー名だけ。
    InvalidHeader(String),
}

/// 送信タスクから Channel で画面側に流すイベント。
///
/// 順序は `Response` → `Chunk`* → `End`。接続失敗は `Error` だけが届く。
/// 受信中の失敗は `Response` → `Chunk`* → `Error`。
/// `rename_all` はバリアント名にしか効かないので、構造体バリアントのフィールド名
/// (`status_text` → `statusText`)は `rename_all_fields` で camelCase に揃える。
#[derive(Serialize, Clone)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HttpEvent {
    Response {
        status: u16,
        status_text: String,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    /// 接続失敗・受信中の切断。種別は常に network。ヘッダー(キー)は含めない。
    Error {
        message: String,
    },
}

/// 開始時の検証を通った、送信できる状態のリクエスト。
///
/// `headers` には付与済みの Authorization(キーの値)が入りうるので、Debug は
/// 実装しない(ログやエラー文言に紛れ込ませないため)。
pub(crate) struct PreparedRequest {
    pub method: Method,
    pub url: Url,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

/// `auth_provider` ごとの認証方式。対応表にないプロバイダ名は `UnsupportedAuth`。
enum AuthScheme {
    /// `Authorization: Bearer <key>`
    Bearer,
}

fn auth_scheme_for(provider: &str) -> Option<AuthScheme> {
    match provider {
        "openai" => Some(AuthScheme::Bearer),
        _ => None,
    }
}

/// URL を解釈し、スキームが http / https であることを確かめる。
/// 文言には書き手が設定した URL をそのまま入れる(キーは入りえない)。
fn validate_url(url: &str) -> Result<Url, HttpStartError> {
    let parsed = Url::parse(url).map_err(|e| HttpStartError::InvalidUrl(format!("{url} ({e})")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err(HttpStartError::InvalidUrl(url.to_string())),
    }
}

/// 開始時の検証と送信の準備をまとめて行う。HTTP は送らない純粋な関数。
///
/// 1. URL を解釈し、スキームが http / https であることを確かめる(Req 2.3)。
/// 2. 呼び出し側の Authorization を大文字小文字を問わず取り除く(Req 7.2)。
/// 3. `auth_provider` の指定があるときだけ、認証方式を確かめてからキーを読み、
///    Authorization を付ける。未設定なら送らない(Req 7.4)。指定がなければ
///    キーは読みに行かない。
///
/// `read_secret` は本番では `secrets::read_secret` を渡す。
pub(crate) fn prepare_request<F>(
    req: HttpRequest,
    read_secret: F,
) -> Result<PreparedRequest, HttpStartError>
where
    F: FnOnce(&str) -> Result<Option<String>, String>,
{
    let url = validate_url(&req.url)?;

    let mut headers = req.headers;
    headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));

    if let Some(provider) = req.auth_provider.as_deref() {
        // 認証方式を先に確かめ、未知のプロバイダ名で keychain を読みに行かない。
        let scheme = auth_scheme_for(provider)
            .ok_or_else(|| HttpStartError::UnsupportedAuth(provider.to_string()))?;
        // 移行前の画面側(`if (!apiKey)`)と同じく、空文字も未設定として扱う。
        let key = match read_secret(provider) {
            Ok(Some(key)) if !key.is_empty() => key,
            Ok(_) => return Err(HttpStartError::MissingSecret(provider.to_string())),
            Err(e) => return Err(HttpStartError::SecretUnavailable(e)),
        };
        match scheme {
            AuthScheme::Bearer => {
                headers.insert("Authorization".to_string(), format!("Bearer {key}"));
            }
        }
    }

    Ok(PreparedRequest {
        method: req.method.to_reqwest(),
        url,
        headers,
        body: req.body,
    })
}

/// 検証済みのリクエストを reqwest のリクエストに組み立てる。HTTP は送らない。
///
/// `prepare_request` が呼び出し側の Authorization を取り除いているので、ここに
/// 残っている Authorization はキーから組み立てたものだけ。変換に失敗したときは
/// 由来で種別を分ける:
/// - 呼び出し側のヘッダー → `InvalidHeader`(文言はヘッダー名だけ)
/// - キー由来の Authorization(改行を含むキー等)→ `SecretUnavailable`
///
/// どちらの文言にもヘッダーの値(キー)は含めない。付与する Authorization は
/// `set_sensitive(true)` でログ出力の対象外にする(Debug 表示で値が伏せられる)。
fn to_reqwest_request(prepared: PreparedRequest) -> Result<reqwest::Request, HttpStartError> {
    let mut headers = HeaderMap::with_capacity(prepared.headers.len());
    for (name, value) in prepared.headers {
        if name.eq_ignore_ascii_case("authorization") {
            let mut value = HeaderValue::from_str(&value).map_err(|_| {
                HttpStartError::SecretUnavailable(
                    "stored API key cannot be used as an Authorization header value".to_string(),
                )
            })?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| HttpStartError::InvalidHeader(name.clone()))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| HttpStartError::InvalidHeader(name.clone()))?;
        headers.insert(header_name, header_value);
    }

    let mut request = reqwest::Request::new(prepared.method, prepared.url);
    *request.headers_mut() = headers;
    if let Some(body) = prepared.body {
        *request.body_mut() = Some(body.into());
    }
    Ok(request)
}

/// 全リクエストで共有する HTTP クライアント(接続の再利用のため)。
/// 初期化の失敗(TLS バックエンドが使えない等)も覚えておき、以後のリクエストは
/// `Error` イベントで終える。
static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

/// 共有クライアントを返す。初回だけ作る。
///
/// - タイムアウトは付けない。タイムアウトは画面側のアダプタが計り、`http_cancel`
///   で打ち切る(Req 5.1)。
/// - リダイレクトは reqwest の既定(最大 10 回たどる)のままにする。reqwest
///   0.12.28 の `redirect::remove_sensitive_headers`(`TowerRedirectPolicy::
///   on_request` から呼ばれる)は、リダイレクト先のホストかポート
///   (`port_or_known_default`)が直前の URL と異なれば Authorization / Cookie /
///   Proxy-Authorization / WWW-Authenticate を取り除く。よって付与したキーが
///   別のホストへ送られることはない。reqwest を更新するときは、この挙動が
///   変わっていないことを確かめ直す(変わっていたら `redirect::Policy::none()`
///   にする)。
fn shared_client() -> Result<&'static reqwest::Client, String> {
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 送信タスクの本体。イベントを `Response` → `Chunk`* → `End` の順で送る。
///
/// - 接続失敗は `Error` だけを送る。受信中の失敗は `Error` で終える。
/// - non-2xx も `Response` として返す(成否の判定は画面側のアダプタが行う)。
/// - 送り先への送信が失敗したら(画面のリロード等で受信側が消えた場合)、直ちに
///   終了する。return で応答と本文ストリームが drop され、接続が切れる。
/// - `Error.message` は reqwest のエラーを文字列化したもの。URL を含むことは
///   あるが、リクエストヘッダー(キー)は含まない。
async fn run_request<S, E>(request: reqwest::Request, sink: S)
where
    S: Fn(HttpEvent) -> Result<(), E>,
{
    let client = match shared_client() {
        Ok(client) => client,
        Err(message) => {
            let _ = sink(HttpEvent::Error { message });
            return;
        }
    };

    let response = match client.execute(request).await {
        Ok(response) => response,
        Err(e) => {
            let _ = sink(HttpEvent::Error {
                message: e.to_string(),
            });
            return;
        }
    };

    // reqwest はサーバーが送った理由句を公開していないので、ステータスコードの
    // 標準の理由句を使う(未知のコードは空文字)。
    let status = response.status();
    let opened = sink(HttpEvent::Response {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
    });
    if opened.is_err() {
        return;
    }

    let mut body = response.bytes_stream();
    while let Some(item) = body.next().await {
        let sent = match item {
            Ok(bytes) => sink(HttpEvent::Chunk {
                bytes: bytes.to_vec(),
            }),
            Err(e) => {
                let _ = sink(HttpEvent::Error {
                    message: e.to_string(),
                });
                return;
            }
        };
        if sent.is_err() {
            return;
        }
    }
    let _ = sink(HttpEvent::End);
}

/// 送信タスクの中断に使うハンドル。
///
/// design は AbortHandle と書くが、tokio の `AbortHandle` は tokio を直接の依存に
/// 加えないと型名を書けない。Tauri の `JoinHandle` も `abort()` を持ち、drop
/// してもタスクは止まらない(切り離されるだけ)ので、中断用にそのまま使う。
type TaskHandle = async_runtime::JoinHandle<()>;

/// 実行中の送信タスクの管理表。`tauri::Builder::manage` でアプリの状態として持つ。
///
/// タスクは終了時(正常終了・エラー・送り先への送信失敗)に自分の ID を外す。
/// `http_cancel` で中断したタスクは `cancel_request` が外す。
pub struct HttpState {
    next_id: AtomicU32,
    tasks: Arc<Mutex<HashMap<u32, TaskHandle>>>,
}

impl Default for HttpState {
    fn default() -> Self {
        Self {
            // 画面側で ID を真偽値として扱っても困らないよう、1 から振る。
            next_id: AtomicU32::new(1),
            tasks: Arc::default(),
        }
    }
}

/// 管理表のロックを取る。中身は ID とハンドルだけで、途中で panic しても壊れた
/// 状態にはならないので、poison は無視して使い続ける。
fn lock_tasks(tasks: &Mutex<HashMap<u32, TaskHandle>>) -> MutexGuard<'_, HashMap<u32, TaskHandle>> {
    tasks.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 開始時の検証を同期で行い、通れば送信タスクを起動して ID を返す。
///
/// 検証(`prepare_request`)と reqwest のリクエストへの変換に失敗したら、送信
/// タスクは起動せず開始時エラーを返す(HTTP は送らない。Req 2.3, 7.4)。
/// `sink` はイベントの送り先。本番では Channel への送信を渡し、テストでは
/// 受け取り用のコレクションに集める関数を渡す。
pub(crate) fn start_request<R, S, E>(
    req: HttpRequest,
    read_secret: R,
    sink: S,
    state: &HttpState,
) -> Result<u32, HttpStartError>
where
    R: FnOnce(&str) -> Result<Option<String>, String>,
    S: Fn(HttpEvent) -> Result<(), E> + Send + 'static,
    E: Send + 'static,
{
    let request = to_reqwest_request(prepare_request(req, read_secret)?)?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let tasks = Arc::clone(&state.tasks);

    // 起動と登録を同じロックの中で行う。タスクは終了時に同じロックを取ってから
    // 自分を外すので、登録より先に外れることはない(design の State Management)。
    let mut registry = lock_tasks(&state.tasks);
    let handle = async_runtime::spawn(async move {
        run_request(request, sink).await;
        lock_tasks(&tasks).remove(&id);
    });
    registry.insert(id, handle);
    Ok(id)
}

/// 送信タスクを中断して管理表から外す。未知の ID や終了済みの ID は無視する。
///
/// abort でタスクの future が drop され、保持していた応答と接続が切れる(Req 4.3)。
/// 管理表から外してから、ロックの外で abort する。
pub(crate) fn cancel_request(id: u32, state: &HttpState) {
    let handle = lock_tasks(&state.tasks).remove(&id);
    if let Some(handle) = handle {
        handle.abort();
    }
}

/// プロバイダへの HTTP リクエストを Rust 側で送り、応答を `on_event` に流す。
/// 戻り値は `http_cancel` に渡す ID。
#[tauri::command]
pub fn http_request(
    req: HttpRequest,
    on_event: Channel<HttpEvent>,
    state: State<'_, HttpState>,
) -> Result<u32, HttpStartError> {
    start_request(
        req,
        secrets::read_secret,
        move |event| on_event.send(event),
        &state,
    )
}

/// `http_request` で起動した送信タスクを中断する。冪等。
#[tauri::command]
pub fn http_cancel(id: u32, state: State<'_, HttpState>) {
    cancel_request(id, &state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn request(url: &str, auth_provider: Option<&str>) -> HttpRequest {
        HttpRequest {
            method: HttpMethod::Post,
            url: url.to_string(),
            headers: HashMap::new(),
            body: Some("{}".to_string()),
            auth_provider: auth_provider.map(str::to_string),
        }
    }

    /// キーを読みに行ったら失敗させる読み出し関数(読まないことの検証用)。
    fn must_not_read(provider: &str) -> Result<Option<String>, String> {
        panic!("read_secret must not be called (provider: {provider})");
    }

    fn expect_err(
        req: HttpRequest,
        read: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> HttpStartError {
        match prepare_request(req, read) {
            Ok(_) => panic!("expected HttpStartError, got Ok"),
            Err(e) => e,
        }
    }

    fn expect_ok(
        req: HttpRequest,
        read: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> PreparedRequest {
        match prepare_request(req, read) {
            Ok(p) => p,
            Err(e) => panic!("expected Ok, got {e:?}"),
        }
    }

    /// 大文字小文字を問わず Authorization ヘッダーの値を集める。
    fn authorization_values(headers: &HashMap<String, String>) -> Vec<&str> {
        headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.as_str())
            .collect()
    }

    #[test]
    fn rejects_non_http_scheme_as_invalid_url() {
        // "localhost:5000/v1" はスキーム "localhost" の URL として解釈される。
        for url in ["ftp://127.0.0.1/v1", "file:///C:/x", "localhost:5000/v1"] {
            let err = expect_err(request(url, None), must_not_read);
            assert!(
                matches!(err, HttpStartError::InvalidUrl(_)),
                "{url}: got {err:?}"
            );
        }
    }

    #[test]
    fn rejects_unparsable_url_as_invalid_url() {
        for url in ["", "not a url", "http://"] {
            let err = expect_err(request(url, None), must_not_read);
            assert!(
                matches!(err, HttpStartError::InvalidUrl(_)),
                "{url:?}: got {err:?}"
            );
        }
    }

    #[test]
    fn invalid_url_is_checked_before_reading_secret() {
        let err = expect_err(request("ftp://example.com", Some("openai")), must_not_read);
        assert!(matches!(err, HttpStartError::InvalidUrl(_)), "got {err:?}");
    }

    #[test]
    fn accepts_http_and_https() {
        for url in [
            "http://127.0.0.1:5000/v1/completions",
            "https://api.openai.com/v1/models",
        ] {
            let prepared = expect_ok(request(url, None), must_not_read);
            assert_eq!(prepared.url.as_str(), url);
            assert_eq!(prepared.method, Method::POST);
            assert_eq!(prepared.body.as_deref(), Some("{}"));
        }
    }

    #[test]
    fn maps_method() {
        let mut req = request("http://127.0.0.1:5000/v1/models", None);
        req.method = HttpMethod::Get;
        assert_eq!(expect_ok(req, must_not_read).method, Method::GET);
    }

    #[test]
    fn missing_secret_when_key_is_not_set() {
        let err = expect_err(request("https://api.openai.com/v1", Some("openai")), |_| {
            Ok(None)
        });
        assert_eq!(err, HttpStartError::MissingSecret("openai".to_string()));
    }

    #[test]
    fn empty_key_is_treated_as_missing_secret() {
        // 移行前の画面側は `if (!apiKey)` で空文字も未設定として扱っていた。
        let err = expect_err(request("https://api.openai.com/v1", Some("openai")), |_| {
            Ok(Some(String::new()))
        });
        assert_eq!(err, HttpStartError::MissingSecret("openai".to_string()));
    }

    #[test]
    fn secret_unavailable_when_keychain_read_fails() {
        let err = expect_err(request("https://api.openai.com/v1", Some("openai")), |_| {
            Err("keychain unavailable".to_string())
        });
        assert_eq!(
            err,
            HttpStartError::SecretUnavailable("keychain unavailable".to_string())
        );
    }

    #[test]
    fn unsupported_auth_for_unknown_provider_without_reading_secret() {
        let err = expect_err(
            request("https://example.com/v1", Some("anthropic")),
            must_not_read,
        );
        assert_eq!(
            err,
            HttpStartError::UnsupportedAuth("anthropic".to_string())
        );
    }

    #[test]
    fn does_not_read_secret_without_auth_provider() {
        let prepared = expect_ok(request("http://127.0.0.1:5000/v1", None), must_not_read);
        assert!(authorization_values(&prepared.headers).is_empty());
    }

    #[test]
    fn strips_caller_authorization_regardless_of_case() {
        let mut req = request("http://127.0.0.1:5000/v1", None);
        req.headers
            .insert("authorization".into(), "Bearer a".into());
        req.headers
            .insert("AUTHORIZATION".into(), "Bearer b".into());
        req.headers
            .insert("Authorization".into(), "Bearer c".into());
        req.headers
            .insert("Content-Type".into(), "application/json".into());

        let prepared = expect_ok(req, must_not_read);
        assert!(authorization_values(&prepared.headers).is_empty());
        assert_eq!(
            prepared.headers.get("Content-Type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(prepared.headers.len(), 1);
    }

    #[test]
    fn attaches_bearer_for_openai_and_replaces_caller_authorization() {
        let mut req = request("https://api.openai.com/v1/chat/completions", Some("openai"));
        req.headers
            .insert("aUtHoRiZaTiOn".into(), "Bearer from-webview".into());

        let mut seen = String::new();
        let prepared = expect_ok(req, |p| {
            seen = p.to_string();
            Ok(Some("test-key-value".to_string()))
        });
        assert_eq!(seen, "openai");
        assert_eq!(
            authorization_values(&prepared.headers),
            vec!["Bearer test-key-value"]
        );
    }

    #[test]
    fn http_request_deserializes_from_camel_case_json() {
        let req: HttpRequest = serde_json::from_str(
            r#"{"method":"POST","url":"http://127.0.0.1:5000/v1","headers":{"Content-Type":"application/json"},"body":"{}","authProvider":"openai"}"#,
        )
        .unwrap();
        assert!(matches!(req.method, HttpMethod::Post));
        assert_eq!(req.auth_provider.as_deref(), Some("openai"));
        assert_eq!(req.body.as_deref(), Some("{}"));

        // body / authProvider は省略できる(None)。
        let req: HttpRequest = serde_json::from_str(
            r#"{"method":"GET","url":"http://127.0.0.1:5000/v1/models","headers":{}}"#,
        )
        .unwrap();
        assert!(matches!(req.method, HttpMethod::Get));
        assert!(req.body.is_none());
        assert!(req.auth_provider.is_none());
    }

    #[test]
    fn start_error_serializes_with_kind_and_message() {
        let cases = [
            (HttpStartError::InvalidUrl("x".into()), "invalidUrl"),
            (HttpStartError::MissingSecret("x".into()), "missingSecret"),
            (
                HttpStartError::SecretUnavailable("x".into()),
                "secretUnavailable",
            ),
            (
                HttpStartError::UnsupportedAuth("x".into()),
                "unsupportedAuth",
            ),
            (HttpStartError::InvalidHeader("x".into()), "invalidHeader"),
        ];
        for (err, kind) in cases {
            assert_eq!(
                serde_json::to_value(&err).unwrap(),
                serde_json::json!({ "kind": kind, "message": "x" })
            );
        }
    }

    #[test]
    fn event_serializes_with_event_and_data() {
        // 画面側(2.4)と手で揃える形をここで固定する。バリアント名もフィールド名も
        // camelCase(`statusText`)で送る。
        assert_eq!(
            serde_json::to_value(HttpEvent::Response {
                status: 200,
                status_text: "OK".into()
            })
            .unwrap(),
            serde_json::json!({ "event": "response", "data": { "status": 200, "statusText": "OK" } })
        );
        assert_eq!(
            serde_json::to_value(HttpEvent::Chunk { bytes: vec![1, 2] }).unwrap(),
            serde_json::json!({ "event": "chunk", "data": { "bytes": [1, 2] } })
        );
        assert_eq!(
            serde_json::to_value(HttpEvent::End).unwrap(),
            serde_json::json!({ "event": "end" })
        );
        assert_eq!(
            serde_json::to_value(HttpEvent::Error {
                message: "e".into()
            })
            .unwrap(),
            serde_json::json!({ "event": "error", "data": { "message": "e" } })
        );
    }

    // ---- reqwest のリクエストへの変換(2.2) ----

    /// prepare_request を通してから reqwest のリクエストに変換する。
    fn convert(
        req: HttpRequest,
        read: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> Result<reqwest::Request, HttpStartError> {
        to_reqwest_request(expect_ok(req, read))
    }

    fn expect_convert_err(
        req: HttpRequest,
        read: impl FnOnce(&str) -> Result<Option<String>, String>,
    ) -> HttpStartError {
        match convert(req, read) {
            Ok(_) => panic!("expected HttpStartError, got Ok"),
            Err(e) => e,
        }
    }

    #[test]
    fn invalid_caller_header_value_is_invalid_header_with_name_only() {
        let mut req = request("http://127.0.0.1:5000/v1", None);
        req.headers
            .insert("X-Custom".into(), "line1\r\nX-Injected: value".into());
        let err = expect_convert_err(req, must_not_read);
        assert_eq!(err, HttpStartError::InvalidHeader("X-Custom".to_string()));
    }

    #[test]
    fn invalid_caller_header_name_is_invalid_header() {
        let mut req = request("http://127.0.0.1:5000/v1", None);
        req.headers.insert("Bad Name".into(), "value".into());
        let err = expect_convert_err(req, must_not_read);
        assert_eq!(err, HttpStartError::InvalidHeader("Bad Name".to_string()));
    }

    #[test]
    fn invalid_key_is_secret_unavailable_without_key_in_message() {
        let key = "test-key\nwith-newline";
        let err = expect_convert_err(request("https://api.openai.com/v1", Some("openai")), |_| {
            Ok(Some(key.to_string()))
        });
        let HttpStartError::SecretUnavailable(message) = &err else {
            panic!("expected SecretUnavailable, got {err:?}");
        };
        assert!(
            !message.contains("test-key"),
            "message leaks key: {message}"
        );
        assert!(
            !message.contains("with-newline"),
            "message leaks key: {message}"
        );
    }

    #[test]
    fn converts_method_url_headers_body_and_marks_authorization_sensitive() {
        let mut req = request("https://api.openai.com/v1/chat/completions", Some("openai"));
        req.headers
            .insert("Content-Type".into(), "application/json".into());

        let converted = match convert(req, |_| Ok(Some("test-key-value".to_string()))) {
            Ok(r) => r,
            Err(e) => panic!("expected Ok, got {e:?}"),
        };
        assert_eq!(converted.method(), Method::POST);
        assert_eq!(
            converted.url().as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            converted.headers().get("content-type").unwrap(),
            "application/json"
        );
        let auth = converted.headers().get(AUTHORIZATION).unwrap();
        assert_eq!(auth, "Bearer test-key-value");
        assert!(auth.is_sensitive());
        // sensitive な値は Debug 表示で伏せられる(ログに紛れても値が出ない)。
        assert!(!format!("{:?}", converted.headers()).contains("test-key-value"));
        assert_eq!(
            converted.body().and_then(|b| b.as_bytes()),
            Some(&b"{}"[..])
        );
    }

    // ---- 送信タスクの起動・中断と管理表(2.2) ----
    // HTTP の中身(順序・中断で接続が閉じること・Bearer の到達)は 2.3 の結合
    // テストで確かめる。ここでは管理表への登録と取り外しだけを見る。

    /// イベントを mpsc に集める送り先。
    fn collector() -> (
        impl Fn(HttpEvent) -> Result<(), mpsc::SendError<HttpEvent>> + Send + 'static,
        mpsc::Receiver<HttpEvent>,
    ) {
        let (tx, rx) = mpsc::channel();
        (move |event| tx.send(event), rx)
    }

    fn registered_ids(state: &HttpState) -> Vec<u32> {
        let mut ids: Vec<u32> = lock_tasks(&state.tasks).keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// 条件が満たされるまで待つ(最大 `timeout`)。
    fn wait_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        cond()
    }

    #[test]
    fn start_error_does_not_spawn_task_or_send_events() {
        let state = HttpState::default();

        let (sink, rx) = collector();
        let err = start_request(
            request("ftp://127.0.0.1/v1", None),
            must_not_read,
            sink,
            &state,
        );
        assert!(matches!(err, Err(HttpStartError::InvalidUrl(_))));

        let mut req = request("http://127.0.0.1:5000/v1", None);
        req.headers.insert("X-Bad".into(), "a\nb".into());
        let (sink2, rx2) = collector();
        let err = start_request(req, must_not_read, sink2, &state);
        assert_eq!(err, Err(HttpStartError::InvalidHeader("X-Bad".to_string())));

        assert!(registered_ids(&state).is_empty());
        // 送り先は start_request に move 済みで、タスクが無いので即座に切断される。
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        assert!(rx2.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn task_removes_itself_from_registry_when_finished() {
        // 一度 bind して閉じたポートは接続を拒否する(接続失敗で即終了させる)。
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let state = HttpState::default();
        let (sink, rx) = collector();
        let id = start_request(
            request(&format!("http://127.0.0.1:{port}/v1"), None),
            must_not_read,
            sink,
            &state,
        )
        .expect("start");
        assert!(id >= 1);

        // 接続失敗の Error イベントが届くまで待ち、その後に管理表から外れることを見る。
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("terminal event");
        assert!(matches!(event, HttpEvent::Error { .. }));
        assert!(
            wait_until(Duration::from_secs(5), || registered_ids(&state).is_empty()),
            "task was not removed: {:?}",
            registered_ids(&state)
        );
    }

    #[test]
    fn cancel_removes_only_the_target_task_and_ignores_unknown_ids() {
        // accept しないリスナー: 接続は backlog で成立するが応答は来ないので、
        // タスクは応答待ちのまま残る。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let state = HttpState::default();

        let (sink_a, rx_a) = collector();
        let (sink_b, _rx_b) = collector();
        let a = start_request(request(&url, None), must_not_read, sink_a, &state).expect("a");
        let b = start_request(request(&url, None), must_not_read, sink_b, &state).expect("b");
        assert_ne!(a, b);
        assert_eq!(registered_ids(&state), {
            let mut v = vec![a, b];
            v.sort_unstable();
            v
        });

        // 未知の ID は無視する。
        cancel_request(u32::MAX, &state);
        assert_eq!(registered_ids(&state).len(), 2);

        cancel_request(a, &state);
        assert_eq!(registered_ids(&state), vec![b]);
        // 中断したタスクからはイベントが届かない(送り先ごと drop される)。
        assert!(matches!(
            rx_a.recv_timeout(Duration::from_millis(200)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));

        // 中断済みの ID をもう一度中断しても何も起きない。
        cancel_request(a, &state);
        assert_eq!(registered_ids(&state), vec![b]);

        cancel_request(b, &state);
        assert!(registered_ids(&state).is_empty());
        drop(listener);
    }

    // ---- ローカルのテスト用サーバーを使った結合テスト(2.3) ----
    // std の TcpListener とスレッドで 1 接続だけ受けるサーバーを立て、
    // start_request / cancel_request を直接呼ぶ。サーバーとテストの足並みは mpsc
    // で揃え、待ちはすべて上限付き(固定の sleep に頼らない)。
    // start_request は送信タスクを Tauri の非同期ランタイムに自分で spawn するので、
    // テスト側で block_on する非同期処理は無い。

    /// イベント 1 件・サーバー側の 1 手順を待つ上限。Windows で閉じたポートへの
    /// 接続が拒否されるまで 2 秒ほどかかるので、それより十分長くとる。
    const WAIT: Duration = Duration::from_secs(10);

    /// テスト失敗時の表示用(HttpEvent は Debug を実装していない)。
    fn describe(event: &HttpEvent) -> String {
        match event {
            HttpEvent::Response {
                status,
                status_text,
            } => {
                format!("Response({status} {status_text})")
            }
            HttpEvent::Chunk { bytes } => format!("Chunk({:?})", String::from_utf8_lossy(bytes)),
            HttpEvent::End => "End".to_string(),
            HttpEvent::Error { message } => format!("Error({message})"),
        }
    }

    fn next_event(rx: &mpsc::Receiver<HttpEvent>) -> HttpEvent {
        rx.recv_timeout(WAIT).expect("event did not arrive in time")
    }

    /// `expected` と同じバイト列がそろうまで Chunk を受け取り、受け取った Chunk の
    /// 数を返す。Chunk 以外のイベントが来たら失敗。
    fn recv_chunks_until(rx: &mpsc::Receiver<HttpEvent>, expected: &[u8]) -> usize {
        let mut received = Vec::new();
        let mut count = 0;
        while received.len() < expected.len() {
            match next_event(rx) {
                HttpEvent::Chunk { bytes } => {
                    received.extend_from_slice(&bytes);
                    count += 1;
                }
                other => panic!("expected Chunk, got {}", describe(&other)),
            }
        }
        assert_eq!(received, expected);
        count
    }

    /// 送信タスクが終わって送り先が drop されるまで、残りのイベントを集める。
    fn collect_rest(rx: &mpsc::Receiver<HttpEvent>) -> Vec<HttpEvent> {
        let deadline = Instant::now() + WAIT;
        let mut events = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(event) => events.push(event),
                Err(mpsc::RecvTimeoutError::Disconnected) => return events,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!(
                    "task did not finish in time; events so far: {:?}",
                    events.iter().map(describe).collect::<Vec<_>>()
                ),
            }
        }
    }

    /// 1 接続だけ受けるテスト用サーバーを立てる。受けたリクエストの頭部(リクエスト行と
    /// ヘッダー)を `head_rx` に送ってから、`respond` に応答を任せる。
    /// 戻り値は (ベース URL, 頭部の受け取り口, サーバースレッド)。
    fn serve_once<F>(respond: F) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>)
    where
        F: FnOnce(&mut std::net::TcpStream) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (head_tx, head_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // サーバー側の読み出しが永久に止まらないよう、上限を付けておく。
            stream.set_read_timeout(Some(WAIT)).unwrap();
            let head = read_request(&mut stream);
            head_tx.send(head).unwrap();
            respond(&mut stream);
        });
        (url, head_rx, server)
    }

    /// リクエストの頭部を読み、Content-Length の分だけ本文を読み捨てて頭部を返す。
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::{BufRead, BufReader, Read};
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).unwrap();
            if n == 0 || line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let content_length = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            .unwrap_or(0);
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).unwrap();
        head
    }

    /// 頭部から、名前が一致する(大文字小文字を問わない)ヘッダーの値をすべて集める。
    fn header_values<'a>(head: &'a str, name: &str) -> Vec<&'a str> {
        head.lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(n, _)| n.trim().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim())
            .collect()
    }

    fn write_all(stream: &mut std::net::TcpStream, bytes: &[u8]) {
        use std::io::Write;
        stream.write_all(bytes).unwrap();
        stream.flush().unwrap();
    }

    /// chunked 転送の 1 チャンクを書いて flush する。
    fn write_chunk(stream: &mut std::net::TcpStream, data: &[u8]) {
        let mut frame = format!("{:x}\r\n", data.len()).into_bytes();
        frame.extend_from_slice(data);
        frame.extend_from_slice(b"\r\n");
        write_all(stream, &frame);
    }

    const CHUNKED_SSE_HEAD: &[u8] =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";

    #[test]
    fn streams_response_then_chunks_per_server_send_then_end() {
        // サーバーは 1 単位を送るたびに、テストからの合図があるまで次を送らない。
        // 合図の前に、その単位の Chunk がもう届いていることを確かめる(Req 3.1, 3.4)。
        let units: [&[u8]; 3] = [
            b"data: {\"text\":\"one\"}\n\n",
            b"data: {\"text\":\"two\"}\n\n",
            b"data: [DONE]\n\n",
        ];
        let (proceed_tx, proceed_rx) = mpsc::channel::<()>();
        let (url, head_rx, server) = serve_once(move |stream| {
            write_all(stream, CHUNKED_SSE_HEAD);
            for (i, unit) in units.iter().enumerate() {
                if i > 0 {
                    proceed_rx
                        .recv_timeout(WAIT)
                        .expect("test did not signal the next send");
                }
                write_chunk(stream, unit);
            }
            write_all(stream, b"0\r\n\r\n");
        });

        let state = HttpState::default();
        let (sink, rx) = collector();
        start_request(
            request(&format!("{url}/v1/completions"), None),
            must_not_read,
            sink,
            &state,
        )
        .expect("start");

        let head = head_rx.recv_timeout(WAIT).expect("request head");
        assert!(
            head.starts_with("POST /v1/completions HTTP/1.1\r\n"),
            "{head}"
        );

        match next_event(&rx) {
            HttpEvent::Response {
                status,
                status_text,
            } => {
                assert_eq!(status, 200);
                assert_eq!(status_text, "OK");
            }
            other => panic!("expected Response, got {}", describe(&other)),
        }

        let mut chunk_count = 0;
        for (i, unit) in units.iter().enumerate() {
            if i > 0 {
                proceed_tx.send(()).unwrap();
            }
            // サーバーはまだ次の単位を送っていないので、ここで届いた Chunk は
            // 全体を待たずに流されたもの。
            chunk_count += recv_chunks_until(&rx, unit);
        }
        assert!(chunk_count >= units.len(), "chunks: {chunk_count}");

        let rest = collect_rest(&rx);
        assert!(
            matches!(rest.as_slice(), [HttpEvent::End]),
            "expected only End, got {:?}",
            rest.iter().map(describe).collect::<Vec<_>>()
        );
        server.join().unwrap();
        assert!(registered_ids(&state).is_empty());
    }

    #[test]
    fn ends_with_end_when_server_closes_without_done() {
        // 長さを示さない応答(本文は接続が閉じるまで)で、SSE の [DONE] を送らずに
        // 接続を閉じる。それまでの Chunk のあとに End で終わる(Req 3.3)。
        let body: &[u8] = b"data: {\"text\":\"partial\"}\n\n";
        let (url, _head_rx, server) = serve_once(move |stream| {
            write_all(
                stream,
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            );
            write_all(stream, body);
            stream.shutdown(std::net::Shutdown::Write).unwrap();
        });

        let state = HttpState::default();
        let (sink, rx) = collector();
        start_request(request(&url, None), must_not_read, sink, &state).expect("start");

        assert!(matches!(
            next_event(&rx),
            HttpEvent::Response { status: 200, .. }
        ));
        recv_chunks_until(&rx, body);
        let rest = collect_rest(&rx);
        assert!(
            matches!(rest.as_slice(), [HttpEvent::End]),
            "expected only End, got {:?}",
            rest.iter().map(describe).collect::<Vec<_>>()
        );
        server.join().unwrap();
    }

    #[test]
    fn cancel_closes_connection_on_server_side() {
        // 1 チャンク目を送ったあと、サーバーは次を送らずに接続の読み出しで待つ。
        // 中断で接続が切られたら read が 0(FIN)かエラー(RST)で返る。読み出しの
        // 上限(WAIT)に達したら、接続が開いたままということ(Req 4.3)。
        let first: &[u8] = b"data: {\"text\":\"one\"}\n\n";
        let (closed_tx, closed_rx) = mpsc::channel::<Result<(), String>>();
        let (url, _head_rx, server) = serve_once(move |stream| {
            use std::io::{ErrorKind, Read};
            write_all(stream, CHUNKED_SSE_HEAD);
            write_chunk(stream, first);
            let mut buf = [0u8; 64];
            let result = match stream.read(&mut buf) {
                Ok(0) => Ok(()),
                Ok(n) => Err(format!("unexpected {n} bytes from client")),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    Err("connection was still open".to_string())
                }
                Err(_) => Ok(()),
            };
            closed_tx.send(result).unwrap();
        });

        let state = HttpState::default();
        let (sink, rx) = collector();
        let id = start_request(request(&url, None), must_not_read, sink, &state).expect("start");

        assert!(matches!(next_event(&rx), HttpEvent::Response { .. }));
        recv_chunks_until(&rx, first);

        cancel_request(id, &state);
        assert!(registered_ids(&state).is_empty());

        // サーバーの読み出し上限より少し長く待つ(上限に達した場合も結果は届く)。
        let closed = closed_rx
            .recv_timeout(WAIT + Duration::from_secs(5))
            .expect("server did not report");
        assert_eq!(closed, Ok(()));

        // 中断後は End も Error も届かない。
        let rest = collect_rest(&rx);
        assert!(
            rest.is_empty(),
            "unexpected events after cancel: {:?}",
            rest.iter().map(describe).collect::<Vec<_>>()
        );
        server.join().unwrap();
    }

    fn respond_ok(stream: &mut std::net::TcpStream) {
        write_all(
            stream,
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        );
    }

    #[test]
    fn server_receives_bearer_from_substituted_secret_reader() {
        // キーの読み出しはテスト値を返す関数に差し替え、keychain には触れない。
        // 呼び出し側の Authorization は届かず、付与したものだけが届く(Req 7.2)。
        let (url, head_rx, server) = serve_once(respond_ok);

        let mut req = request(&format!("{url}/v1/chat/completions"), Some("openai"));
        req.headers
            .insert("Authorization".into(), "Bearer from-webview".into());
        req.headers
            .insert("Content-Type".into(), "application/json".into());

        let mut asked = Vec::new();
        let state = HttpState::default();
        let (sink, rx) = collector();
        start_request(
            req,
            |provider: &str| {
                asked.push(provider.to_string());
                Ok(Some("test-key-value".to_string()))
            },
            sink,
            &state,
        )
        .expect("start");
        assert_eq!(asked, vec!["openai"]);

        let head = head_rx.recv_timeout(WAIT).expect("request head");
        assert_eq!(
            header_values(&head, "authorization"),
            vec!["Bearer test-key-value"],
            "{head}"
        );
        assert_eq!(
            header_values(&head, "content-type"),
            vec!["application/json"]
        );

        let mut events = vec![next_event(&rx)];
        events.extend(collect_rest(&rx));
        assert!(
            matches!(
                events.as_slice(),
                [HttpEvent::Response { status: 200, .. }, .., HttpEvent::End]
            ),
            "{:?}",
            events.iter().map(describe).collect::<Vec<_>>()
        );
        server.join().unwrap();
    }

    #[test]
    fn server_receives_no_authorization_without_auth_provider() {
        // プロバイダ名の指定がなければ、呼び出し側が Authorization を付けても届かない。
        let (url, head_rx, server) = serve_once(respond_ok);

        let mut req = request(&url, None);
        req.headers
            .insert("authorization".into(), "Bearer from-webview".into());

        let state = HttpState::default();
        let (sink, rx) = collector();
        start_request(req, must_not_read, sink, &state).expect("start");

        let head = head_rx.recv_timeout(WAIT).expect("request head");
        assert!(header_values(&head, "authorization").is_empty(), "{head}");
        collect_rest(&rx);
        server.join().unwrap();
    }

    #[test]
    fn unreachable_endpoint_sends_only_error() {
        // 一度 bind して閉じたポートは接続を拒否する(Req 5.2)。
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let state = HttpState::default();
        let (sink, rx) = collector();
        start_request(
            request(&format!("http://127.0.0.1:{port}/v1"), None),
            must_not_read,
            sink,
            &state,
        )
        .expect("start");

        let events = collect_rest(&rx);
        assert!(
            matches!(events.as_slice(), [HttpEvent::Error { .. }]),
            "expected only Error, got {:?}",
            events.iter().map(describe).collect::<Vec<_>>()
        );
    }
}
