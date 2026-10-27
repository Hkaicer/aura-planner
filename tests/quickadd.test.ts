import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../shared/quickadd";

const today = "2026-10-25"; // a Sunday

describe("quick add parser", () => {
  it("parses an English capture line", () => {
    const r = parseQuickAdd("Call mom tomorrow 18:00 30m !high #family +Personal", today);
    expect(r).toMatchObject({ title: "Call mom", plannedDate: "2026-10-26", start: "18:00", estimateMin: 30, priority: "high", tags: ["family"], project: "Personal" });
  });

  it("parses French shorthand and keeps 18h as a time but 1h30 as a duration", () => {
    const r = parseQuickAdd("Rapport de labo demain 18h 1h30 !critique avant vendredi", today);
    expect(r).toMatchObject({ title: "Rapport de labo", plannedDate: "2026-10-26", start: "18:00", estimateMin: 90, priority: "critical", dueDate: "2026-10-30" });
  });

  it("understands weekdays, 12-hour times and plain titles", () => {
    expect(parseQuickAdd("Gym friday 6:30pm 1h", today)).toMatchObject({ title: "Gym", plannedDate: "2026-10-30", start: "18:30", estimateMin: 60 });
    expect(parseQuickAdd("Read the 3 chapters", today)).toMatchObject({ title: "Read the 3 chapters", plannedDate: null, estimateMin: null });
    expect(parseQuickAdd("Dentist at 9", today)).toMatchObject({ title: "Dentist", start: "09:00", plannedDate: today });
  });

  it("parses explicit dates", () => {
    expect(parseQuickAdd("Submit form 02/11", today).plannedDate).toBe("2026-11-02");
    expect(parseQuickAdd("Submit form 2026-12-01", today).plannedDate).toBe("2026-12-01");
  });
});
