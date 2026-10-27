import type { Recurrence } from "@shared/schemas";
import type { Lang } from "./i18n";

const DAYS = {
  en: ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  fr: ["", "lun", "mar", "mer", "jeu", "ven", "sam", "dim"],
};

export function describeRecurrence(r: Recurrence, lang: Lang): string {
  const days = (r.byWeekday ?? []).map((d) => DAYS[lang][d]).join(", ");
  const at = r.time ? (lang === "fr" ? ` à ${r.time}` : ` at ${r.time}`) : "";
  if (lang === "fr") {
    if (r.freq === "daily") return (r.interval > 1 ? `Tous les ${r.interval} jours` : "Tous les jours") + at;
    if (r.freq === "monthly") return (r.interval > 1 ? `Tous les ${r.interval} mois` : "Tous les mois") + at;
    return (r.interval > 1 ? `Toutes les ${r.interval} semaines` : "Chaque semaine") + (days ? ` (${days})` : "") + at;
  }
  if (r.freq === "daily") return (r.interval > 1 ? `Every ${r.interval} days` : "Every day") + at;
  if (r.freq === "monthly") return (r.interval > 1 ? `Every ${r.interval} months` : "Every month") + at;
  return (r.interval > 1 ? `Every ${r.interval} weeks` : "Weekly") + (days ? ` on ${days}` : "") + at;
}
