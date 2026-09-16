import fs from "fs";
import path from "path";

const KILL_FILE = path.resolve("data", "killswitch.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(KILL_FILE, "utf8"));
  } catch {
    return { active: false };
  }
}

let state = readState();

function persist() {
  fs.mkdirSync(path.dirname(KILL_FILE), { recursive: true });
  fs.writeFileSync(KILL_FILE, JSON.stringify(state, null, 2));
}

export function isKillSwitchActive() {
  return state.active;
}

export function activateKillSwitch(reason) {
  state = { active: true, reason: reason ?? "manual", at: new Date().toISOString() };
  persist();
}

export function deactivateKillSwitch() {
  state = { active: false };
  persist();
}

export function getKillSwitchState() {
  return { ...state };
}

// Deliberate design choice: the kill switch blocks new BUYS only (manual
// and sniped) — it never blocks sells. A switch that traps you in a
// position you're trying to exit during an emergency is worse than no
// switch at all. If something's going wrong, you can always still sell.
