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
  var walkButton = function () {
    return document.querySelector('[data-guide-command="walk route"]');
  };
  /* Sep 29 2026: the step button used to vanish on arrival while it held focus,
   * dropping a screen reader to the top of the page. As in Part 180, a focused
   * button stays, marked done, until focus moves on. */
  function showWalk(show) {
    var button = walkButton();
    if (show) {
      button.hidden = false;
      delete button.dataset.done;
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-label');
    } else if (button === document.activeElement) {
      button.dataset.done = '1';
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-label', button.textContent + ', done. You have arrived.');
    } else {
      button.hidden = true;
    }
  }
  function renderPath(guide) {
    var panel = $('routePanel');
    /* closing the card never leaves focus on something hidden */
    if (!guide && !panel.hidden && panel.contains(document.activeElement))
      $('guideOpen').focus({ preventScroll: true });
    path = guide;
    panel.hidden = !guide;
    if (!guide) return;
    $('routeTitle').textContent = guide.title;
    $('routeSummary').textContent = guide.summary;
    showWalk(true);
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
          if (button.dataset.done) return;
          api.send(button.dataset.guideCommand, room && room.roomId);
        };
      });
      walkButton().addEventListener('blur', function () {
        var button = walkButton();
        /* a window losing focus keeps the button focused; wait for a real move */
        if (button.dataset.done && button !== document.activeElement) button.hidden = true;
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
      /* the server puts a route away on arrival, so an arrived card only
       * lasts while you stay at the destination */
      if (index < 0 || (path.arrived && index !== path.stops.length - 1)) {
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
      if (!remaining) path.arrived = true;
      showWalk(remaining > 0);
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
        var saved = $('savedRoute');
        if (!progress.destination && saved === document.activeElement)
          $('guideOpen').focus({ preventScroll: true });
        saved.hidden = !progress.destination;
        if (!progress.destination && !(path && path.arrived)) renderPath(null);
      }
      if (result.guide) renderPath(result.guide);
    },
  };
})();
