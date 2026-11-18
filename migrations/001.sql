CREATE TABLE IF NOT EXISTS intents (
 id INTEGER PRIMARY KEY, channel TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL,
 caption TEXT NOT NULL, url TEXT NOT NULL, mode TEXT NOT NULL, session TEXT, state TEXT NOT NULL,
 remoteId TEXT, reason TEXT, sentAt TEXT, externalLink TEXT, UNIQUE(channel,hash), UNIQUE(channel,remoteId)
);
CREATE TABLE IF NOT EXISTS highlights(channel TEXT, highlight TEXT, intent INTEGER NOT NULL REFERENCES intents(id), PRIMARY KEY(channel,highlight));
CREATE TABLE IF NOT EXISTS cooldown(channel TEXT PRIMARY KEY, untilMs INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS policy(session TEXT PRIMARY KEY, source TEXT NOT NULL, channel TEXT NOT NULL, cap INTEGER NOT NULL CHECK(cap>0));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, session TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, details TEXT NOT NULL, result TEXT, evaluation TEXT, reason TEXT, intent INTEGER REFERENCES intents(id));
PRAGMA user_version=1;
