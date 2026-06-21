// Shared mutable client state. Modules read/write this one live object so the
// values stay in sync (you can't reassign an imported binding across modules).
export const state = {
  me: null, // logged-in user or null
  session: null, // current SessionRow (on the session view)
  shareId: null, // current session's share id (the access capability)
  activeRunId: null, // active attempt id
  routes: [],
  levelCaps: [],
};

// Every session/run-scoped request carries the share id as the capability.
export const runHeaders = () =>
  state.shareId ? { "x-share-id": state.shareId } : {};
