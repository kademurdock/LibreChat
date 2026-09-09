(function () {
  'use strict';
  var latest = null,
    api = null;
  var $ = function (id) {
    return document.getElementById(id);
  };
  var esc = function (s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c];
    });
  };
  function rect(x, y, w, h, fill, r) {
    return (
      '<rect x="' +
      x +
      '" y="' +
      y +
      '" width="' +
      w +
      '" height="' +
      h +
      '" rx="' +
      (r || 0) +
      '" fill="' +
      fill +
      '"/>'
    );
  }
  function circle(x, y, r, fill) {
    return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + fill + '"/>';
  }
  function hash(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return n;
  }
  function avatar(name, x, y) {
    var n = hash(name),
      shirt = ['#42676e', '#ae623f', '#d1a859', '#706181', '#a4545f'][n % 5],
      skin = ['#ad7654', '#744b36', '#d7a079', '#edc4a4'][Math.floor(n / 5) % 4];
    return (
      '<g transform="translate(' +
      x +
      ' ' +
      y +
      ')">' +
      '<ellipse cx="0" cy="54" rx="22" ry="7" fill="#17212b" opacity=".18"/>' +
      rect(-11, 29, 9, 25, '#303d48', 3) +
      rect(3, 29, 9, 25, '#303d48', 3) +
      rect(-19, 1, 38, 34, shirt, 12) +
      circle(0, -7, 14, skin) +
      '<path d="M-14,-8 Q-14,-28 1,-23 Q18,-22 14,-6 Q8,-15 -14,-8" fill="#332b2a"/>' +
      circle(-4, -6, 1.1, '#352c28') +
      circle(5, -6, 1.1, '#352c28') +
      '<path d="M-3,1 Q1,4 5,1" stroke="#5c3f34" stroke-width="1.5" fill="none"/>' +
      '</g>'
    );
  }
  function plant(x, y) {
    return (
      '<g transform="translate(' +
      x +
      ' ' +
      y +
      ')">' +
      rect(-12, 0, 24, 26, '#bd8061', 4) +
      '<path d="M0,3V-41 M0,-17Q-31,-45 -24,-11Q-14,0 0,-8 M0,-27Q26,-52 25,-24Q17,-12 0,-17" stroke="#395647" fill="#5e8664" stroke-width="3"/></g>'
    );
  }
  function draw(room, hud) {
    var outdoor = room.outdoor,
      home = !!room.home,
      bar = /bar|rails|stage|band/.test(room.roomId),
      diner = /diner|kettle|truck_stop/.test(room.roomId),
      dark = hud && hud.dark;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 440" focusable="false" aria-hidden="true">';
    svg += rect(0, 0, 800, 440, dark ? '#253c49' : '#d4e5df');
    if (outdoor && room.sensory && room.sensory.nature) {
      svg +=
        '<path d="M0 182Q170 93 365 188T800 158V440H0Z" fill="' +
        (dark ? '#263f3c' : '#769778') +
        '"/>';
      svg +=
        '<path d="M0 275Q300 201 800 263V440H0Z" fill="' + (dark ? '#304944' : '#8aa16f') + '"/>';
      for (var tree = 0; tree < 9; tree++) {
        var tx = tree * 102 + 12,
          ty = 118 + (tree % 3) * 24;
        svg +=
          rect(tx, ty, 14, 173, '#675647', 3) +
          circle(tx + 7, ty, 58, dark ? '#23463e' : ['#638865', '#81945e', '#497563'][tree % 3]);
      }
      svg +=
        '<path d="M282 440Q358 365 417 295Q452 258 416 234L448 226Q510 270 470 319L407 440Z" fill="#baa17c"/>';
      if (room.sensory.water) {
        svg +=
          '<path d="M0 296Q202 240 389 321T800 320V410Q570 431 350 372T0 359Z" fill="#65979b"/><path d="M20 325Q184 284 357 339M442 367Q582 395 774 356" stroke="#bfd1bd" stroke-width="4" fill="none"/>';
        for (var stone = 0; stone < 7; stone++)
          svg +=
            '<ellipse cx="' +
            stone * 123 +
            '" cy="' +
            (324 + (stone % 2) * 44) +
            '" rx="25" ry="12" fill="#858e80"/>';
      }
      if (room.roomId === 'alder_camp')
        svg +=
          '<ellipse cx="330" cy="338" rx="66" ry="25" fill="#687267"/><path d="M289 340L367 329M294 328L360 346" stroke="#67503e" stroke-width="12" stroke-linecap="round"/><path d="M311 336Q286 310 321 283Q315 309 342 292Q366 321 343 337Z" fill="#d68a4c"/><path d="M324 335Q310 319 332 306Q350 326 337 337Z" fill="#f4c46e"/>';
      if (room.roomId === 'alder_hide')
        svg +=
          rect(61, 209, 183, 110, '#9c7959', 5) +
          '<path d="M43 213L148 155L264 213Z" fill="#586b55"/>' +
          rect(84, 231, 135, 26, '#354b43', 2);
      svg +=
        circle(686, 316, 9, '#b8aa8c') +
        '<ellipse cx="693" cy="297" rx="4" ry="15" fill="#b8aa8c"/>' +
        '<ellipse cx="682" cy="298" rx="4" ry="14" fill="#b8aa8c"/>';
    } else if (outdoor) {
      svg += circle(657, 62, 26, dark ? '#f3e7c4' : '#ffe3a4') + rect(0, 230, 800, 210, '#84967a');
      svg += '<path d="M0 361L800 285V440H0Z" fill="#c7b89c"/>';
      for (var i = 0; i < 4; i++)
        svg +=
          rect(
            i * 188 - 38,
            117 - (i % 2) * 20,
            157,
            151,
            ['#b67d62', '#d7bd96', '#719598', '#cfaa74'][i],
            3,
          ) +
          rect(i * 188 + 7, 170, 34, 59, '#344f5a', 2) +
          rect(i * 188 + 68, 171, 35, 32, '#ead9ac', 2);
      svg +=
        plant(63, 277) +
        plant(725, 270) +
        rect(460, 289, 155, 12, '#78573f', 3) +
        rect(471, 300, 9, 50, '#594d43') +
        rect(594, 300, 9, 50, '#594d43') +
        rect(465, 263, 144, 20, '#896446', 3);
      if (/pier|dock|water|hook/.test(room.roomId))
        svg +=
          '<path d="M0 345Q120 330 240 352T490 353L800 355V440H0Z" fill="#527f88"/><path d="M0 395L680 322L800 369L190 440H0Z" fill="#a28769"/><path d="M68 405L718 335M118 426L763 352" stroke="#806c59" stroke-width="3"/>';
    } else {
      svg += rect(0, 0, 800, 265, bar ? '#6b665d' : home ? '#d8c6ac' : '#d8b692');
      svg +=
        '<path d="M0 270H800V440H0Z" fill="#a47e5e"/><path d="M0 265H800M70 440L270 268M330 440L420 268M620 440L563 268M0 348H800M0 405H800" stroke="#846349" stroke-width="3" opacity=".5"/>';
      svg +=
        rect(43, 41, 194, 150, '#ede2cd', 7) +
        rect(53, 51, 174, 130, dark ? '#284652' : '#87b0ae', 2) +
        rect(132, 48, 8, 139, '#e6dac2') +
        rect(50, 114, 180, 7, '#e6dac2');
      svg +=
        rect(280, 47, 102, 111, '#e6dac2', 2) +
        rect(289, 56, 84, 93, '#536d62', 1) +
        '<path d="M299 131L322 86L345 123L362 101V139H299Z" fill="#d1b77f"/>';
      if (!home) svg += plant(729, 236);
      if (bar || diner) {
        svg += rect(440, 90, 272, 10, '#594d40', 2) + rect(440, 154, 272, 10, '#594d40', 2);
        for (var j = 0; j < 9; j++)
          svg +=
            rect(454 + j * 27, 111, 13, 41, j % 2 ? '#c7ad79' : '#597b6b', 3) +
            rect(458 + j * 27, 103, 5, 12, '#3e544a', 2);
        svg +=
          rect(401, 228, 320, 75, bar ? '#745345' : '#788f86', 4) +
          rect(384, 214, 346, 22, '#d6b785', 4);
        for (var k = 0; k < 4; k++)
          svg +=
            rect(426 + k * 80, 304, 7, 54, '#514a42') +
            rect(414 + k * 80, 298, 32, 12, '#9a584c', 7);
        if (diner)
          svg += rect(44, 232, 144, 62, '#b46a53', 13) + rect(48, 269, 144, 23, '#bc725b', 8);
      } else if (!home) {
        svg +=
          rect(403, 223, 244, 86, '#617f79', 16) +
          rect(389, 256, 37, 68, '#54716c', 12) +
          rect(627, 256, 37, 68, '#54716c', 12) +
          rect(436, 241, 67, 36, '#dec49a', 6) +
          rect(547, 243, 62, 36, '#c3896c', 6);
        svg +=
          rect(71, 223, 133, 79, '#775742', 3) +
          rect(81, 233, 112, 12, '#423b35') +
          rect(89, 246, 7, 45, '#cfa465') +
          rect(102, 246, 12, 45, '#76958f') +
          rect(117, 246, 9, 45, '#bd7f60');
      }
    }
    if (home)
      (room.furniture || []).slice(0, 8).forEach(function (name, i) {
        var x = 70 + (i % 4) * 178,
          y = 250 + Math.floor(i / 4) * 74;
        svg +=
          rect(x, y, 118, 48, '#8c725b', 6) +
          '<text x="' +
          (x + 59) +
          '" y="' +
          (y + 28) +
          '" text-anchor="middle" fill="#fff" font-size="10">' +
          esc(String(name).slice(0, 21)) +
          '</text>';
      });
    if ((!home && !(room.sensory && room.sensory.nature)) || room.hangout)
      svg +=
        '<ellipse cx="316" cy="353" rx="100" ry="27" fill="#302923" opacity=".15"/>' +
        rect(262, 323, 9, 54, '#705644') +
        rect(353, 323, 9, 54, '#705644') +
        '<ellipse cx="313" cy="317" rx="82" ry="33" fill="#d6b483"/>';
    if (room.hangout)
      svg +=
        circle(304, 311, 15, '#eee2cb') +
        circle(340, 320, 12, '#eee2cb') +
        rect(281, 298, 17, 18, '#bb674e', 3);
    var names = [(hud && hud.name) || 'You']
      .concat(
        (room.peopleDetail || []).map(function (p) {
          return p.name;
        }),
      )
      .slice(0, 8);
    names.forEach(function (name, i) {
      var pos = [
        [214, 326],
        [389, 325],
        [522, 323],
        [141, 280],
        [677, 299],
        [310, 234],
        [589, 228],
        [69, 333],
      ][i];
      svg += avatar(name, pos[0], pos[1]);
    });
    svg += '</svg>';
    var fallback = $('reverieIllustration').querySelector('.reverie-fallback');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'reverie-fallback';
      $('reverieIllustration').appendChild(fallback);
    }
    fallback.innerHTML = svg;
    $('sceneCaption').textContent =
      room.name +
      ' · ' +
      ((room.peopleDetail || []).length === 0
        ? 'A moment to yourself'
        : 1 + (room.peopleDetail || []).length + ' here together');
  }
  var stage = null,
    failed = false,
    motion = true;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function syncStage() {
    var host = $('reverieIllustration');
    if (!$('motionToggle')) return;
    $('motionToggle').setAttribute('aria-pressed', String(motion));
    $('motionToggle').textContent = reduced.matches
      ? 'World motion: reduced by device'
      : 'World motion: ' + (motion ? 'on' : 'off');
    ['viewLeft', 'viewRight', 'viewNear', 'viewFar'].forEach(function (id) {
      $(id).disabled = host.hidden || failed || !window.ReverieStage;
    });
    if (host.hidden || failed) {
      if (stage) {
        stage.dispose();
        stage = null;
      }
      return;
    }
    if (!latest || !window.ReverieStage) return;
    if (!stage) {
      try {
        stage = new window.ReverieStage.Stage(host, function () {
          failed = true;
          if (stage) {
            stage.dispose();
            stage = null;
          }
          $('pictureStatus').textContent =
            'The illustrated view is active; 3D is unavailable on this device.';
        });
      } catch (error) {
        failed = true;
        host.querySelectorAll('canvas').forEach(function (c) {
          c.remove();
        });
        $('pictureStatus').textContent =
          'The illustrated view is active; 3D is unavailable on this device.';
        return;
      }
    }
    stage.update(latest.room, latest.hud);
    stage.setMotion(motion && !reduced.matches);
  }
  window.addEventListener('reverie-stage-ready', syncStage);
  reduced.addEventListener('change', syncStage);
  window.addEventListener('pagehide', function () {
    if (stage) {
      stage.dispose();
      stage = null;
    }
  });
  window.addEventListener('pageshow', syncStage);
  function render(room, hud) {
    latest = { room: room, hud: hud };
    draw(room, hud);
    syncStage();
    var g = room.hangout,
      box = $('hangoutPanel');
    if (!g && box.contains(document.activeElement)) $('cmdInput').focus();
    box.hidden = !g;
    if (!g) return;
    $('hangoutTitle').textContent = g.title;
    $('hangoutSummary').textContent = g.summary;
    $('hangoutPrompt').textContent = g.prompt;
    $('hangoutGuests').textContent = 'Joined: ' + g.guests.join(', ');
    var list = $('hangoutMoments');
    var text = g.entries
      .map(function (e) {
        return e.name + ': ' + e.text;
      })
      .join('\n');
    if (list.dataset.text !== text) {
      list.dataset.text = text;
      list.replaceChildren();
      g.entries.forEach(function (e) {
        var li = document.createElement('li');
        li.textContent = e.name + ': ' + e.text;
        list.appendChild(li);
      });
    }
    var existing = new Map(
      Array.from($('hangoutActions').children).map(function (b) {
        return [b.dataset.cmd, b];
      }),
    );
    g.choices.forEach(function (c) {
      var b = existing.get(c.cmd);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.cmd = c.cmd;
        $('hangoutActions').appendChild(b);
      }
      existing.delete(c.cmd);
      b.textContent = c.label;
      b.onclick = function () {
        api.send(c.cmd);
      };
    });
    existing.forEach(function (b) {
      var focused = b === document.activeElement;
      b.remove();
      if (focused) $('hangoutTitle').focus();
    });
    $('hangoutAdd').onclick = function () {
      api.compose('hangout add ', g.id);
    };
  }
  window.ReverieRoom = {
    init: function (callbacks) {
      api = callbacks;
      try {
        motion = localStorage.getItem('reverie_motion') !== 'off';
      } catch (e) {}
      $('motionToggle').onclick = function () {
        motion = !motion;
        try {
          localStorage.setItem('reverie_motion', motion ? 'on' : 'off');
        } catch (e) {}
        syncStage();
      };
      $('describePicture').onclick = function () {
        if (!latest) {
          api.describe('Enter the world first to describe its picture.');
          return;
        }
        if (!stage) {
          api.describe('The illustrated view shows ' + latest.room.name + '. ' + latest.room.desc);
          return;
        }
        api.describe(window.ReverieStage.describePicture(stage.model));
      };
      [
        ['viewLeft', -0.2, 0],
        ['viewRight', 0.2, 0],
        ['viewNear', 0, 0.1],
        ['viewFar', 0, -0.1],
      ].forEach(function (v) {
        $(v[0]).onclick = function () {
          if (stage) stage.view(v[1], v[2]);
        };
      });
      $('illustrationToggle').onclick = function () {
        var hidden = $('reverieIllustration').hidden;
        $('reverieIllustration').hidden = !hidden;
        this.setAttribute('aria-pressed', String(hidden));
        this.textContent = 'Room picture: ' + (hidden ? 'on' : 'off');
        syncStage();
        try {
          localStorage.setItem('reverie_picture', hidden ? 'on' : 'off');
        } catch (e) {}
      };
      $('readingToggle').onclick = function () {
        var on = document.body.classList.toggle('easy-reading');
        this.setAttribute('aria-pressed', String(on));
        this.textContent = 'Roomy text: ' + (on ? 'on' : 'off');
        try {
          localStorage.setItem('reverie_reading', on ? 'on' : 'off');
        } catch (e) {}
      };
      try {
        if (localStorage.getItem('reverie_picture') === 'off') $('illustrationToggle').click();
        if (localStorage.getItem('reverie_reading') === 'on') $('readingToggle').click();
      } catch (e) {}
    },
    render: render,
    result: function (result) {
      if (result.mode && result.mode !== 'play') {
        latest = null;
        if (stage) {
          stage.dispose();
          stage = null;
        }
        $('reverieIllustration').replaceChildren();
        return;
      }
      if (latest && result.hud) {
        latest.hud = result.hud;
        syncStage();
      }
      if (stage && result.ok) stage.cue(result.kinds || []);
    },
    people: function (people) {
      if (latest) {
        latest.room.peopleDetail = people;
        draw(latest.room, latest.hud);
        syncStage();
      }
    },
  };
})();
