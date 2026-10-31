-- Persist before uploading any part so a crashed receiver can be aborted on recovery.
ALTER TABLE media_upload_staging ADD COLUMN multipart_id TEXT;
