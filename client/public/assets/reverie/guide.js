(function () {
  'use strict';
  var api,
    room,
    path = null;
  var $ = function (id) {
    return document.getElementById(id);
  };
  var directions = {
    n: 'north',
    s: 'south',
    e: 'east',
    w: 'west',
    ne: 'northeast',
    nw: 'northwest',
    se: 'southeast',
    sw: 'southwest',
    u: 'up',
    d: 'down',
    in: 'in',
    out: 'out',
  };
  function renderPath(guide) {
    path = guide;
    $('routePanel').hidden = !guide;
    if (!guide) return;
    $('routeTitle').textContent = guide.title;
    $('routeSummary').textContent = guide.summary;
    document.querySelector('[data-guide-command="walk route"]').hidden = false;
    var list = $('routeStops');
    list.replaceChildren();
    guide.stops.forEach(function (stop, index) {
      var li = document.createElement('li');
      li.textContent = (index === 0 ? 'Start: ' : '') + stop.name;
      li.dataset.room = stop.id;
      if (stop.id === guide.current) li.setAttribute('aria-current', 'location');
      list.appendChild(li);
    });
    $('routeTitle').focus({ preventScroll: true });
  }
  window.ReverieGuide = {
    init: function (callbacks) {
      api = callbacks;
      document.querySelectorAll('[data-guide-command]').forEach(function (button) {
        button.onclick = function () {
          api.send(button.dataset.guideCommand, room && room.roomId);
        };
      });
      $('closeRoute').onclick = function () {
        renderPath(null);
        $('guideOpen').focus();
      };
    },
    room: function (next) {
      room = next;
      if (!path) return;
      var index = path.stops.findIndex(function (stop) {
        return stop.id === room.roomId;
      });
      if (index < 0) {
        renderPath(null);
        return;
      }
      Array.from($('routeStops').children).forEach(function (li, i) {
        li.classList.toggle('passed', i < index);
        if (i === index) li.setAttribute('aria-current', 'location');
        else li.removeAttribute('aria-current');
      });
      var remaining = path.stops.length - 1 - index;
      var nextStop = path.stops[index + 1];
      document.querySelector('[data-guide-command="walk route"]').hidden = !remaining;
      $('routeSummary').textContent = remaining
        ? remaining +
          (remaining === 1 ? ' step remains. Next: ' : ' steps remain. Next: ') +
          (directions[nextStop.direction] || nextStop.direction) +
          ' to ' +
          nextStop.name +
          '.'
        : 'You have arrived. Choose something to do here.';
    },
    result: function (result) {
      $('guidePanel').hidden = result.mode === 'create';
      if (result.mode === 'create') {
        renderPath(null);
        return;
      }
      if (result.hud && result.hud.guide) {
        var progress = result.hud.guide;
        $('guideProgress').textContent =
          progress.completed === progress.total
            ? 'Canal trail complete. Your discoveries and projects are saved in your notebook.'
            : 'Canal notebook: ' +
              progress.completed +
              ' of ' +
              progress.total +
              ' stops. Take the free trail at your own pace.';
        $('savedRoute').hidden = !progress.destination;
        if (!progress.destination) renderPath(null);
      }
      if (result.guide) renderPath(result.guide);
    },
  };
})();
