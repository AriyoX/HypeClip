ALTER TABLE jobs ADD COLUMN destination TEXT;
ALTER TABLE jobs ADD COLUMN destinationMode TEXT;
UPDATE jobs SET destination=(SELECT channel FROM policy WHERE session=jobs.session AND source=jobs.source),
 destinationMode=(SELECT mode FROM policy WHERE session=jobs.session AND source=jobs.source);
CREATE TABLE live_sources(id TEXT PRIMARY KEY, config TEXT NOT NULL, anchor TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0, ended TEXT);
CREATE TABLE live_segments(source TEXT NOT NULL REFERENCES live_sources(id), path TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL);
CREATE INDEX live_segment_range ON live_segments(source,start,end);
CREATE TABLE live_windows(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES live_sources(id), start INTEGER NOT NULL, end INTEGER NOT NULL, spike TEXT NOT NULL,
 destination TEXT NOT NULL, mode TEXT, state TEXT NOT NULL, triggerAt INTEGER NOT NULL, readyAt INTEGER, renderAt INTEGER, decisionAt INTEGER, reason TEXT);
CREATE INDEX live_window_range ON live_windows(source,state,start,end);
CREATE TABLE live_stages(job TEXT NOT NULL, stage TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
PRAGMA user_version=6;
