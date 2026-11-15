import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useAppStore, ProjectMeta } from "@/stores/appStore";
import { useAIConfigStore } from "@/stores/aiConfigStore";
import { initLlamaServerStore } from "@/stores/llamaServerStore";
import { useSettingsContextStore } from "@/stores/settingsContextStore";
import { WelcomeScreen } from "@/components/welcome/WelcomeScreen";
import { NewProjectDialog } from "@/components/welcome/NewProjectDialog";
import { ProjectView } from "@/components/project/ProjectView";
import { ToastViewport, toastError, toastInfo } from "@/components/ui/Toast";
import {
  createProject,
  isProjectRoot,
  openProject,
  pushRecentProject,
  readRecentProjects,
  removeRecentProject,
} from "@/domain/project/projectApi";
import { refreshIncludedSettings } from "@/domain/project/settingsApi";
import { useGlobalKeymap } from "@/editor/globalKeymap";
import { sanitizeFolderName } from "@/lib/folderName";
import type { RecentProjectEntry } from "@/domain/project/types";

// llama-server のストアの初期化は、アプリの生存期間に 1 回だけ。StrictMode は effect を
// 2 回走らせるので、印は effect の後始末で消えないモジュールのスコープに置く。
let llamaServerInitStarted = false;

export default function App() {
  const { t } = useTranslation();
  const screen = useAppStore((s) => s.screen);
  const setCurrentProject = useAppStore((s) => s.setCurrentProject);
  const loadAIConfig = useAIConfigStore((s) => s.loadFromMeta);
  const clearAIConfig = useAIConfigStore((s) => s.clear);
  const clearSettingsContext = useSettingsContextStore((s) => s.clear);

  const [recents, setRecents] = useState<RecentProjectEntry[]>([]);
  const [newDialogParent, setNewDialogParent] = useState<string | null>(null);

  // Ctrl+S グローバルキーマップ(プロジェクト未起動時は performSnapshotSave 側で no-op)
  useGlobalKeymap();

  // 起動時に recent.json をロード
  useEffect(() => {
    void refreshRecents();
  }, []);

  // llama-server の設定はアプリ側のものなので、プロジェクトを開く前に読む。
  // 読むだけで、llama-server は起動しない(失敗は初期化の中で握りつぶしてある)。
  useEffect(() => {
    if (llamaServerInitStarted) return;
    llamaServerInitStarted = true;
    void initLlamaServerStore();
  }, []);

  // currentProject が null になったタイミングで AI 設定・included キャッシュもクリア
  useEffect(() => {
    return useAppStore.subscribe((state, prev) => {
      if (prev.currentProject && !state.currentProject) {
        clearAIConfig();
        clearSettingsContext();
      }
    });
  }, [clearAIConfig, clearSettingsContext]);

  async function refreshRecents() {
    const list = await readRecentProjects();
    setRecents(list);
  }

  async function openProjectAt(path: string) {
    try {
      const meta = await openProject(path);
      const entry: RecentProjectEntry = {
        path,
        title: meta.title,
        lastOpenedAt: new Date().toISOString(),
      };
      await pushRecentProject(entry);
      await refreshRecents();
      loadAIConfig(meta);
      // 設定タブの includeInContext キャッシュを初期ロード(失敗してもプロジェクト起動は継続)
      try {
        await refreshIncludedSettings(path);
      } catch (e) {
        toastError(t("toast.contextLoadFailed", { message: String(e) }));
      }
      setCurrentProject({ path, title: meta.title, lastOpenedAt: entry.lastOpenedAt });
    } catch (e) {
      toastError(String(e));
    }
  }

  async function handleOpen() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("welcome.selectProjectFolder"),
    });
    if (typeof selected !== "string") return;

    if (!(await isProjectRoot(selected))) {
      toastError(t("toast.projectNotFound"));
      return;
    }
    await openProjectAt(selected);
  }

  async function handleCreate() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("welcome.selectParentFolder"),
    });
    if (typeof selected !== "string") return;

    if (await isProjectRoot(selected)) {
      toastError(t("toast.parentIsProject"));
      return;
    }
    setNewDialogParent(selected);
  }

  async function handleSelectRecent(p: ProjectMeta) {
    if (!(await isProjectRoot(p.path))) {
      toastError(t("toast.projectMissing"));
      await removeRecentProject(p.path);
      await refreshRecents();
      return;
    }
    await openProjectAt(p.path);
  }

  async function handleConfirmCreate({
    title,
    author,
  }: {
    title: string;
    author: string;
  }) {
    if (!newDialogParent) return;
    const parentPath = newDialogParent;

    // サニタイズ再評価(防御層、Dialog 側で既に弾かれている前提)
    const sanitizeResult = sanitizeFolderName(title);
    if (!sanitizeResult.ok) {
      return;
    }
    const folderName = sanitizeResult.folderName;

    try {
      const { meta, projectPath } = await createProject({
        parentPath,
        folderName,
        title,
        author,
      });
      setNewDialogParent(null);
      toastInfo(t("toast.projectCreated"));
      const entry: RecentProjectEntry = {
        path: projectPath,
        title,
        lastOpenedAt: new Date().toISOString(),
      };
      await pushRecentProject(entry);
      await refreshRecents();
      loadAIConfig(meta);
      setCurrentProject({
        path: projectPath,
        title,
        lastOpenedAt: entry.lastOpenedAt,
      });
    } catch (e) {
      const message = String(e);
      let toastKey: string;
      if (message.startsWith("Conflict:")) {
        toastKey = "toast.folderConflict";
      } else if (message.startsWith("NestedProject:")) {
        toastKey = "toast.parentIsProject";
      } else {
        // InvalidName: / Io: / その他
        toastKey = "toast.createProjectFailed";
      }
      toastError(t(toastKey, { message }));
      // エラー時は Dialog を閉じない(setNewDialogParent を null に戻さない)
      // → 衝突時の再入力導線を保持(Req 3.2)
    }
  }

  return (
    <>
      {screen === "welcome" ? (
        <WelcomeScreen
          recentProjects={recents.map((r) => ({
            path: r.path,
            title: r.title,
            lastOpenedAt: r.lastOpenedAt,
          }))}
          onCreate={handleCreate}
          onOpen={handleOpen}
          onSelectRecent={handleSelectRecent}
        />
      ) : (
        <ProjectView />
      )}

      <NewProjectDialog
        open={newDialogParent !== null}
        parentPath={newDialogParent ?? ""}
        onCancel={() => setNewDialogParent(null)}
        onConfirm={handleConfirmCreate}
      />
      <ToastViewport />
    </>
  );
}
