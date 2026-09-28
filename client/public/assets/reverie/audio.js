(function (root) {
  'use strict';
  function createAudio(environment) {
    var ctx,
      unlocked = false,
      cache = new Map(),
      pending = new Map(),
      failures = new Set(),
      loops = new Set();
    var notify = function () {};
    function status() {
      notify(
        !unlocked || !ctx || ctx.state === 'running'
          ? failures.size
            ? 'Retry sounds'
            : ''
          : 'Resume sounds',
      );
    }
    function context() {
      if (!ctx || ctx.state === 'closed') {
        var AudioContext = environment.AudioContext || environment.webkitAudioContext;
        if (!AudioContext) return null;
        ctx = new AudioContext();
        ctx.onstatechange = function () {
          if (ctx.state === 'running')
            loops.forEach(function (item) {
              item.play();
            });
          status();
        };
      }
      return ctx;
    }
    function unlock() {
      unlocked = true;
      var audio = context();
      if (!audio) return;
      // Resume synchronously inside a click, including VoiceOver activation.
      if (audio.state !== 'running') audio.resume().then(status, status);
      var silent = audio.createBufferSource();
      silent.buffer = audio.createBuffer(1, 1, audio.sampleRate);
      silent.connect(audio.destination);
      silent.onended = function () {
        silent.disconnect();
      };
      silent.start();
      status();
    }
    function load(url) {
      if (cache.has(url)) return Promise.resolve(cache.get(url));
      if (pending.has(url)) return pending.get(url);
      var audio = context();
      if (!audio) return Promise.reject(new Error('Audio is unavailable'));
      var abort = new environment.AbortController();
      var timer = environment.setTimeout(function () {
        abort.abort();
      }, 15000);
      var request = environment
        .fetch(url, { signal: abort.signal })
        .then(function (response) {
          if (!response.ok) throw new Error('Sound download failed');
          return response.arrayBuffer();
        })
        .then(function (bytes) {
          return audio.decodeAudioData(bytes);
        })
        .then(function (buffer) {
          failures.delete(url);
          cache.set(url, buffer);
          // Ambience keeps its own reference; the effect cache stays bounded.
          if (cache.size > 24) cache.delete(cache.keys().next().value);
          status();
          return buffer;
        })
        .catch(function (error) {
          failures.add(url);
          status();
          throw error;
        })
        .finally(function () {
          environment.clearTimeout(timer);
          pending.delete(url);
        });
      pending.set(url, request);
      return request;
    }
    function play(url, volume, allowed) {
      var requested = Date.now();
      return load(url)
        .then(function (buffer) {
          var audio = context();
          if (
            !unlocked ||
            audio.state !== 'running' ||
            Date.now() - requested > 2500 ||
            (allowed && !allowed())
          )
            return false;
          var source = audio.createBufferSource(),
            gain = audio.createGain();
          source.buffer = buffer;
          gain.gain.value = volume;
          source.connect(gain);
          gain.connect(audio.destination);
          source.onended = function () {
            source.disconnect();
            gain.disconnect();
          };
          source.start();
          return true;
        })
        .catch(function () {
          if (
            !unlocked ||
            Date.now() - requested > 2500 ||
            (allowed && !allowed()) ||
            !environment.Audio
          )
            return false;
          // Owner-installed remote files may allow media playback without CORS.
          var media = new environment.Audio(url);
          media.volume = volume;
          return media.play().then(
            function () {
              failures.delete(url);
              status();
              return true;
            },
            function () {
              return false;
            },
          );
        });
    }
    function loop(url, volume) {
      var wanted = true,
        source = null,
        gain = null,
        buffer = null,
        loading = null,
        media = null,
        value = volume;
      var item = {
        get volume() {
          return value;
        },
        set volume(next) {
          value = next;
          if (gain) gain.gain.value = next;
          if (media) media.volume = next;
        },
        get paused() {
          return media ? media.paused : !source || !ctx || ctx.state !== 'running';
        },
        play: function () {
          wanted = true;
          loops.add(item);
          if (media)
            return media.play().then(
              function () {
                failures.delete(url);
                status();
              },
              function () {},
            );
          if (source) return Promise.resolve();
          if (loading) return loading;
          loading = (buffer ? Promise.resolve(buffer) : load(url))
            .then(function (decoded) {
              buffer = decoded;
              var audio = context();
              if (!wanted || !unlocked || audio.state !== 'running') return;
              source = audio.createBufferSource();
              gain = audio.createGain();
              source.buffer = buffer;
              source.loop = true;
              gain.gain.value = value;
              source.connect(gain);
              gain.connect(audio.destination);
              source.start();
            })
            .catch(function () {
              if (!wanted || !environment.Audio) return;
              media = new environment.Audio(url);
              media.loop = true;
              media.volume = value;
              return media.play().then(
                function () {
                  failures.delete(url);
                  status();
                },
                function () {},
              );
            })
            .finally(function () {
              loading = null;
            });
          return loading;
        },
        pause: function () {
          wanted = false;
          loops.delete(item);
          if (media) media.pause();
          if (source) {
            source.stop();
            source.disconnect();
            source = null;
          }
          if (gain) {
            gain.disconnect();
            gain = null;
          }
        },
      };
      item.play();
      return item;
    }
    return {
      context: context,
      unlock: unlock,
      play: play,
      loop: loop,
      onStatus: function (callback) {
        notify = callback;
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = createAudio;
  else root.ReverieAudio = createAudio(root);
})(typeof window === 'object' ? window : null);
