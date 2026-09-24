const { exec } = require('child_process');

console.time('yt-dlp');
exec('yt-dlp -j -f "best[ext=mp4][height<=720]" https://www.youtube.com/watch?v=aqz-KE-bpKQ', (err, stdout) => {
  console.timeEnd('yt-dlp');
  if (err) return console.error(err);
  try {
    const data = JSON.parse(stdout);
    console.log(data.url.substring(0, 100));
  } catch (e) {
    console.error(e);
  }
});
