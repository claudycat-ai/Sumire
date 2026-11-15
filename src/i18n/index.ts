import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

const STORAGE_KEY = "sumire.locale";

function detectInitialLocale(): "ja" | "en" {
  if (typeof window !== "undefined") {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "ja" || saved === "en") return saved;
    } catch {
      // localStorage unavailable, fall through to navigator.language
    }
  }
  if (typeof navigator !== "undefined") {
    const lang = navigator.language ?? "";
    if (lang.toLowerCase().startsWith("ja")) return "ja";
  }
  return "en";
}

void i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: detectInitialLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

// 開発時のみ DevTools Console から触れるようグローバルに露出。
// 例: i18n.changeLanguage('en') / i18n.changeLanguage('ja')
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { i18n: typeof i18n }).i18n = i18n;
}

export default i18n;
