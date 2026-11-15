// Rust 側(commands/llama_server.rs、commands/preferences.rs)と受け渡す形。
// フィールド名は Rust 側の JSON(camelCase)と一致させる。

export interface StartLlamaServerRequest {
  executablePath: string;
  /** 絶対パス */
  modelPath: string;
  /** 正の整数 */
  contextSize: number;
  /** 1 要素が 1 引数 */
  extraArgs: string[];
}

export type LlamaServerStatus =
  | {
      state: "stopped";
      runId: number;
      cause: "initial" | "requested" | "exited";
      exitCode: number | null;
    }
  | {
      state: "loading";
      runId: number;
      modelPath: string;
      contextSize: number;
      port: number;
    }
  | {
      state: "ready";
      runId: number;
      modelPath: string;
      contextSize: number;
      port: number;
    }
  | {
      state: "failed";
      runId: number;
      reason: "spawn" | "exited";
      executablePath: string;
      modelPath: string;
      message: string;
      exitCode: number | null;
    };

export interface GgufModel {
  fileName: string;
  sizeBytes: number;
}

/** アプリ側の設定 `preferences.json` の `llamaServer`。`sumire.json` には書かない。 */
export interface LlamaServerPreferences {
  /** 未設定は "" */
  executablePath: string;
  /** 未設定は "" */
  modelsDir: string;
  /** 1 要素が 1 引数 */
  extraArgs: string[];
  /** ファイル名 */
  selectedModel: string | null;
  /** キーはファイル名。エントリが無いモデルは、コンテキスト長が未設定 */
  models: Record<string, { contextSize: number }>;
}
