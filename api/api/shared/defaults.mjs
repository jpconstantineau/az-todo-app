// api/shared/defaults.mjs
export const defaultSettings = {
  contexts: [
    "@Home",
    "@Work",
    "@Errands",
    "@Computer",
    "@Phone",
    "@Meeting",
    "@Email",
    "@Reading",
    "@Someday"
  ],
  areas: [
    "Personal",
    "Family",
    "Health",
    "Finances",
    "Learning",
    "Work: Employer A",
    "Work: Employer B",
    "Community"
  ],
  energy: ["Low", "Medium", "High"],
  timeRequired: ["5m", "15m", "30m", "60m", "120m"],
  priority: ["P1", "P2", "P3", "P4", "P5"],
  statuses: ["next", "waiting", "scheduled", "someday", "active", "completed"]
};