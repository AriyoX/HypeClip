ALTER TABLE policy ADD COLUMN mode TEXT NOT NULL DEFAULT 'addToQueue'
 CHECK(mode IN ('addToQueue','shareNow'));
PRAGMA user_version=5;
