ALTER TABLE intents ADD COLUMN remoteStatus TEXT;
ALTER TABLE intents ADD COLUMN schedulingType TEXT;
ALTER TABLE intents ADD COLUMN notificationStatus TEXT;
CREATE TABLE evaluations (
 id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id),
 evaluatedAt TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, outcome TEXT NOT NULL
);
INSERT INTO evaluations(job,provider,model,outcome)
 SELECT id,json_extract(evaluation,'$.provider'),json_extract(evaluation,'$.model'),evaluation
 FROM jobs WHERE evaluation IS NOT NULL;
PRAGMA user_version=4;
