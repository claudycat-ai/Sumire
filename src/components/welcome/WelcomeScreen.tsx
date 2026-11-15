import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { ProjectMeta } from "@/stores/appStore";

interface WelcomeScreenProps {
  recentProjects: ProjectMeta[];
  onCreate: () => void;
  onOpen: () => void;
  onSelectRecent: (project: ProjectMeta) => void;
}

export function WelcomeScreen({
  recentProjects,
  onCreate,
  onOpen,
  onSelectRecent,
}: WelcomeScreenProps) {
  const { t, i18n } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-8 py-12">
      <div className="w-full max-w-2xl">
        <header className="mb-12 text-center">
          <h1 className="mb-2 text-5xl font-semibold tracking-tight text-purple-700 dark:text-purple-300">
            Sumire
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {t("welcome.tagline")}
          </p>
        </header>

        <div className="mb-10 flex justify-center gap-4">
          <Button size="lg" onClick={onCreate}>
            {t("welcome.createNew")}
          </Button>
          <Button size="lg" variant="secondary" onClick={onOpen}>
            {t("welcome.open")}
          </Button>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("welcome.recentProjects")}
          </h2>
          {recentProjects.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-300 px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
              {t("welcome.noRecent")}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-200 overflow-hidden rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {recentProjects.map((project) => (
                <li key={project.path}>
                  <button
                    type="button"
                    onClick={() => onSelectRecent(project)}
                    className="block w-full px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {project.title}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {project.path}
                    </div>
                    {project.lastOpenedAt && (
                      <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                        {t("welcome.lastOpened", {
                          relative: formatRelativeTime(
                            project.lastOpenedAt,
                            i18n.language,
                            t,
                          ),
                        })}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function formatRelativeTime(
  iso: string,
  lang: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return t("time.secondsAgo", { n: diffSec });
  if (diffSec < 3600) return t("time.minutesAgo", { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t("time.hoursAgo", { n: Math.floor(diffSec / 3600) });
  if (diffSec < 86400 * 30)
    return t("time.daysAgo", { n: Math.floor(diffSec / 86400) });
  return new Date(iso).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US");
}
