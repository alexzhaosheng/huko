// DEPRECATED: the global Drizzle handle has been removed. Each
// SqliteInfraPersistence / SqliteSessionPersistence opens its own
// connection in its constructor. This stub remains only because
// the Linux sandbox cannot delete the file from Windows-side ACLs.
export {};
