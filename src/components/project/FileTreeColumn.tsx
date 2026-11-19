import { useUILayoutStore } from "@/stores/uiLayoutStore";
import { FileTreeHeader } from "@/components/project/FileTreeHeader";
import { FileTreePane } from "@/components/project/FileTreePane";
import { LLMSwitcherPane } from "@/components/project/LLMSwitcherPane";
import { HistoryPane } from "@/components/project/HistoryPane";

interface FileTreeColumnProps {
  projectPath: string;
}

/**
 * ファイル一覧の列。ヘッダ・ファイル一覧・LLM 切替・履歴を縦に並べる。
 * ヘッダはスクロール域の外に置くので、ファイル一覧を送っても上に残る。
 * 配置が右のときは order-last で見た目の順だけを後ろへ回し、境界線を左側に付ける。
 * 子は配置によらず同じ位置・同じ型で並べ、切り替えでマウントし直されないようにする。
 */
export function FileTreeColumn({ projectPath }: FileTreeColumnProps) {
  const placement = useUILayoutStore((s) => s.fileTreePlacement);
  const placementClass =
    placement === "right" ? "order-last border-l" : "border-r";

  return (
    <aside
      className={`flex h-full w-[260px] flex-shrink-0 flex-col overflow-hidden ${placementClass} border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950`}
    >
      <FileTreeHeader />
      <div className="flex-1 overflow-y-auto">
        <FileTreePane projectPath={projectPath} />
      </div>
      <LLMSwitcherPane />
      <HistoryPane projectPath={projectPath} />
    </aside>
  );
}
