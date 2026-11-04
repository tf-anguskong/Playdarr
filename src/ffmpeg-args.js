/**
 * ffmpeg-args.js — checks the "custom encoder options" setting (LIVETV_VIDEO_ARGS).
 *
 * Those options are appended to the Live TV ffmpeg command, and that setting can be changed from the
 * admin Settings page. Free-form ffmpeg arguments can do far more than pick an encoder: a bare word
 * becomes an extra output file (ffmpeg can write anywhere the container can), and options such as
 * -i, -filter_complex, -attach or -passlogfile read or write files. So only known video-encoder options
 * are accepted, each followed by exactly one simple value, which leaves no room for a file path.
 */

const OPTIONS = new Set([
  '-c:v', '-codec:v', '-vcodec',
  '-preset', '-tune', '-profile:v', '-level', '-level:v', '-tier',
  '-b:v', '-maxrate', '-maxrate:v', '-minrate', '-bufsize',
  '-crf', '-cq', '-qp', '-qmin', '-qmax', '-global_quality',
  '-rc', '-rc_mode', '-rc-lookahead', '-look_ahead', '-multipass', '-b_ref_mode',
  '-g', '-keyint_min', '-bf', '-refs', '-sc_threshold', '-forced-idr',
  '-spatial-aq', '-temporal-aq', '-aq-strength',
  '-pix_fmt', '-zerolatency', '-low_power', '-quality', '-usage', '-async_depth',
]);
// An encoder name, preset, number or bitrate: h264_nvenc, p4, 6M, -1, yuv420p, main10, 4.1
const VALUE = /^(-?\d+(\.\d+)?[kKmM]?|[A-Za-z0-9_][A-Za-z0-9_.+]{0,39})$/;

/** Split and check the setting. Returns the argument array, or throws an Error saying what's wrong. */
function parseVideoArgs(str) {
  const toks = String(str ?? '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new Error('Enter at least one option, for example -c:v h264_nvenc');
  for (let i = 0; i < toks.length; i += 2) {
    const opt = toks[i], val = toks[i + 1];
    if (!OPTIONS.has(opt)) {
      throw new Error(`"${opt.slice(0, 30)}" isn't an allowed encoder option. Allowed: ${[...OPTIONS].join(' ')}`);
    }
    if (val === undefined) throw new Error(`"${opt}" needs a value after it`);
    if (!VALUE.test(val)) throw new Error(`"${val.slice(0, 30)}" isn't a valid value for ${opt}`);
  }
  return toks;
}

module.exports = { parseVideoArgs, ALLOWED_VIDEO_OPTIONS: OPTIONS };
