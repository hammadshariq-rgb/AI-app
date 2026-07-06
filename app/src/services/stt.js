const fs = require('fs');
const os = require('os');
const path = require('path');
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribe(audioBuffer) {
  console.log('Received audio buffer, byte length:', audioBuffer.length);
  const tmpPath = path.join(os.tmpdir(), `jarvis-${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, audioBuffer);
  console.log('Wrote temp file:', tmpPath);
  try {
    console.log('Calling OpenAI Whisper...');
    const res = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });
    console.log('Whisper responded:', res.text);
    return res.text;
  } catch (err) {
    console.log('Whisper call FAILED:', err.message);
    throw err;
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

module.exports = { transcribe };
