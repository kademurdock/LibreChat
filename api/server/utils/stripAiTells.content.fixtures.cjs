const weather = "Still hot today, around 90, cloudy, and feeling like 88. Tomorrow's high is 85 with a 50% chance of rain and wind up to 18. Friday drops to 70, with a low of 59 and a 71% chance of rain. Finally, some relief from this shit. Saturday is cloudy at 75, low 56, with little rain expected. Sunday reaches 83 under clouds. Monday is mostly clear at 77. Tuesday is partly cloudy at 75, dropping to 48 overnight.";

const positive = [
  ['plain warmth', 'Hey, you made it. Come sit with me for a minute.'],
  ['casual banter and profanity', 'That bass line is filthy. I want it louder, damn it.'],
  ['specific feeling with how', 'I love how the bass comes in late. It makes the chorus hit harder.'],
  ['specific feeling with that', 'I love that song. The bass line is filthy.'],
  ['correction with colon', "You're right: the appointment is Friday at six. I had Thursday written down."],
  ['correction with comma and semicolon', "You're right, it's Friday at six; Thursday was my mistake. I'll change the note."],
  ['amplified correction with content', "You're absolutely right: 84 divided by 2 is 42. I used the wrong divisor."],
  ['uncertain acknowledgment as question', "You're right? Wait, I had it down for Thursday."],
  ['ordinary uncertainty', 'I might be wrong about the start time. The timetable I have says 6:40.'],
  ['correction preserving uncertainty', "You're right: I can't confirm today's delays from this timetable. Check the departure board before you leave."],
  ['full weather coverage', weather],
  ['fenced code plus genuine feeling', 'The chorus starts here:\n```text\nI love how the bass comes in late.\nYou\'re right: 84 / 2 = 42.\n```\nI love that song. Play it again.'],
];

const stock = [
  ['standalone acknowledgment', "You're right. The bus leaves at six.", 'The bus leaves at six.'],
  ['standalone amplified acknowledgment', "You're absolutely right! The bus leaves at six.", 'The bus leaves at six.'],
  ['standalone praise', 'I love that! The bus leaves at six.', 'The bus leaves at six.'],
  ['praise and connective and closer', 'Great question! In summary, use the second switch. Hope this helps!', 'Use the second switch.'],
  ['label deletion', "You buy the cheap printer and then pay for ink forever. That's the trap.", 'You buy the cheap printer and then pay for ink forever.'],
  ['lead-in deletion', "Here's the thing: use the second switch.", 'Use the second switch.'],
  ['mask-slip deletion remains', 'As an AI, I can help. Use the second switch.', 'Use the second switch.'],
];

const outOfScope = [
  ['real-time limitation disclosure', "I don't have access to real-time train delays. The last timetable I saw lists 6:40, so check the departure board before you leave.", 'The last timetable I saw lists 6:40, so check the departure board before you leave.'],
  ['specific character lead-in', "Here's what kills me: they charge extra for the strap. The bag already costs a fortune.", 'They charge extra for the strap. The bag already costs a fortune.'],
];

module.exports = { positive, stock, outOfScope };
