# Media worker v1
Run `python -m workers.media --request <json-file> --result <json-file>`. Exchange UTF-8 JSON. The schemas and paired examples are in v1/. Substitute local absolute paths and the actual digest when running an example. No credentials or provider calls belong in the worker.
 
Time zero is the first frame of the source. Cut [startMs,endMs), with endMs greater than startMs. Output files reside under outputDir. originalPath refers to the trimmed source-aspect clip, verticalPath to the final MP4. Layout fit-pad scales and pads, center-crop fills and centrally crops. The transcript conforms to transcript.schema.json. Transcript segments and SRT timestamps are clip-relative. durationMs describes the actual vertical clip. sha256 is the lowercase digest of that file. Any quality flag requires review. Write result JSON before exiting, with exit code zero for success or nonzero for structured failure.

Sol owns media/, workers/, their fixtures and tests. The TypeScript session owns contracts/, root CLI and tooling, src/, migrations/, CLI tests/fixtures, lockfiles and README.
