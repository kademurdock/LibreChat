'use strict';
// A rendering cue, never a diagnosis of the character or user. This module
// performs no inference/network work and never changes the speech input.
//
// Sep 19 2026 (Kade: "It should have a wide scope of keywords and
// expressions"). The first vocabulary knew six expressions and about twenty
// words, and any direction containing "no", "not" or "without" went neutral.
// Measured against a day of real directions from deepseek-v4.1-flash ("dry a
// little raspy", "flat and hot like I'm mad on her behalf", "flat and clipped
// with no patience left") nearly every one landed on neutral, so the face
// never followed the voice. Now: twenty-two expressions, each with a wide word
// family, a negated phrase is dropped instead of blanking the whole direction,
// and every expression carries a STYLE the renderers share (brow, head, pace,
// blink), so a new expression needs no new code in a player.
const AvatarExpression = (() => {
  const sounds = new Map([
    ['laugh','amused'],['chuckle','amused'],['giggle','amused'],['cackle','amused'],['snicker','amused'],['snort','amused'],
    ['squeal','excited'],['whoop','excited'],['cheer','excited'],
    ['scoff','skeptical'],['tsk','skeptical'],['tongue click','skeptical'],
    ['gasp','surprised'],['shriek','surprised'],
    ['sigh','concerned'],['groan','frustrated'],['growl','angry'],['huff','frustrated'],
    ['cry','sad'],['sob','sad'],['sniffle','sad'],['whimper','sad'],['wail','sad'],
    ['yawn','tired'],['hum','thoughtful'],['gulp','afraid'],
  ]);
  for(const name of ['breath','breathe','inhale','exhale','pant','grunt','moan','whine','sniff','howl','clear throat','clears throat','cough','sneeze','hiccup','burp','snore','choke','gag','swallow','spit','kiss','whistle','shush','hush'])sounds.set(name,null);

  // First match wins, so the stronger and more visible feeling sits higher:
  // "warm but completely serious" is serious, "flat and hot" is angry.
  const w=(words)=>new RegExp('\\b(?:'+words+')\\b');
  const rules=[
    ['angry',w('angry|anger|mad|furious|fury|livid|seething|fuming|rage|raging|enraged|irate|hot|heated|snarl\\w*|growl\\w*|outraged?|pissed|venom\\w*|spitting|hostile|fierce(?:ly)?|biting|scathing|yell\\w*|shout\\w*|scream\\w*|roar\\w*|bark\\w*')],
    ['frustrated',w('frustrat\\w*|exasperat\\w*|irritat\\w*|annoyed|annoyance|fed up|impatient|impatience|clipped|curt|terse|snapp\\w*|short fuse|testy|aggravated|bristl\\w*|gritted|through (?:your |my )?teeth|done with')],
    ['afraid',w('afraid|scared|fear\\w*|frightened|terrified|panick?\\w*|alarmed|nervous(?:ly)?|anxious(?:ly)?|anxiety|jittery|shaky|shaking|trembl\\w*|uneasy|on edge|spooked|dread\\w*|rattled')],
    ['sad',w('sad|sadness|sadly|sorrow\\w*|grie[fv]\\w*|mourn\\w*|heartbroken|heavy[- ]?hearted|tearful|teary|crying|choked up|choking up|wounded|hurt|aching|ache|bereft|lonely|wistful|melanchol\\w*|low and sad|defeated|deflated|crestfallen|hollow')],
    ['concerned',w('worried|worry|concerned|concern|troubled|protective|sympathetic|sympathy|compassion\\w*|apologetic|sorry|regretful|gentle concern|pained')],
    ['disgusted',w('disgust\\w*|grossed out|revolted|repulsed|appalled|sneer\\w*|contempt\\w*|scornful|scorn|disdain\\w*|withering')],
    ['surprised',w('surprised?|astonish\\w*|startled|shocked|stunned|amazed|amazement|awed?|awestruck|disbelie\\w*|incredulous|taken aback|floored|wide[- ]eyed|caught off guard|blindsided|marvel\\w*')],
    ['excited',w('excited(?:ly)?|excitement|thrilled|elated|ecstatic|overjoyed|joyful|joyous|joy|jubilant|delighted|delight|giddy|bubbl\\w*|bright(?:ly)?|bouncy|bouncing|buzzing|hyped?|pumped|eager(?:ly)?|enthusias\\w*|exuberant|gush\\w*|beaming|triumphant|celebrat\\w*|tripping over yourself')],
    ['amused',w('amused|amusement|laugh\\w*|chuckl\\w*|giggl\\w*|cackl\\w*|cracking up|snicker\\w*|tickled|funny|humor\\w*|humour\\w*|grin\\w*|mirth\\w*|entertained|wheez\\w*')],
    ['playful',w('playful(?:ly)?|teasing(?:ly)?|tease|mischie\\w*|impish|cheeky|sly(?:ly)?|flirt\\w*|coy|sassy|sass|saucy|silly|goofy|joking|kidding|ribbing|needling|sing[- ]?song|conspiratorial(?:ly)?|winking|wink')],
    ['smug',w('smug(?:ly)?|self[- ]satisfied|proud(?:ly)?|pleased with (?:yourself|myself)|gloat\\w*|cocky|superior|vindicated|told you so|satisfied|preening|showing off')],
    ['skeptical',w('skeptical(?:ly)?|sceptical(?:ly)?|doubtful|doubting|doubt|unconvinced|suspicious(?:ly)?|dubious|wary|warily|side[- ]?eye\\w*|unimpressed|not buying|arch(?:ly)?|pointed(?:ly)?|raised eyebrow|eyebrow raised|questioning')],
    ['serious',w('serious(?:ly)?|solemn(?:ly)?|firm(?:ly)?|stern(?:ly)?|grave(?:ly)?|sober(?:ly)?|level|leveling|levelling|measured|steady|steadily|direct|blunt(?:ly)?|no[- ]nonsense|matter[- ]of[- ]fact|resolute|taking charge|commanding|authoritative|warning|urgent(?:ly)?|intense(?:ly)?|earnest(?:ly)?|sincere(?:ly)?')],
    ['dry',w('dry|dryly|drily|deadpan|flat(?:ly)?|wry(?:ly)?|sardonic\\w*|sarcas\\w*|ironic\\w*|droll|laconic|bone[- ]dry|monotone|unbothered|bored|unamused')],
    ['tired',w('tired|weary|wearily|exhausted|worn out|worn|drained|sleepy|drowsy|groggy|yawning|spent|run down|fatigued|sluggish|raspy|hoarse')],
    ['thoughtful',w('thoughtful(?:ly)?|thinking|pondering|ponder|musing|mulling|reflective|reflecting|considering|careful(?:ly)?|cautious(?:ly)?|contemplat\\w*|working it out|slow(?:ly)? and careful|deliberate(?:ly)?|taking your time|choosing (?:your|each) words?')],
    ['curious',w('curious(?:ly)?|curiosity|intrigued|interested|inquisitive|leaning in|lean in|fascinated|nosy|probing|puzzled|perplexed|confused|quizzical(?:ly)?')],
    ['tender',w('tender(?:ly)?|soft(?:ly|er|ening)?|gentle|gently|quiet(?:ly|er)?|hushed|whisper\\w*|murmur\\w*|intimate|low and close|soothing|comforting|loving(?:ly)?|affectionate(?:ly)?|cradling|careful with (?:her|him|them|you)')],
    ['confident',w('confident(?:ly)?|sure|certain|assured|self[- ]assured|bold(?:ly)?|decisive(?:ly)?|strong(?:ly)?|unshak\\w*|brisk(?:ly)?|crisp(?:ly)?|business[- ]?like|landing it')],
    ['calm',w('calm(?:ly|er|ing)?|relaxed|easy|easygoing|unhurried|settled|settling|peaceful|serene|mellow|laid[- ]back|even|evenly|patient(?:ly)?|reassuring(?:ly)?|grounded|slowing down')],
    ['warm',w('warm(?:ly|er|ing|th)?|fond(?:ly|ness)?|friendly|kind(?:ly)?|welcoming|smil\\w*|glad|happy|happily|cheerful(?:ly)?|cheery|sunny|pleasant(?:ly)?|pleased|grateful|appreciative|encouraging|supportive|proud of (?:you|her|him|them)|in your corner|in her corner')],
  ];
  const NEGATED=/\b(?:not|never|without|no|hardly|barely any|zero|isn't|aren't|don't|doesn't)\s+(?:a |an |any |the |at all |even |really |so |very |quite |much |being |sounding |letting |giving |going )*[a-z'-]+/g;

  // How each expression moves a face that has brows, a head and eyelids.
  //   brow      resting brow raise, 0..1        browTalk  extra raise with loudness
  //   tilt      head tilt bias in degrees       sway      size of the idle head drift
  //   nod       size of the speech nod          tempo     speed of all of it
  //   blink     blink period multiplier (<1 blinks more)   lift  px up(-) or down(+)
  const style=(brow,browTalk,tilt,sway,nod,tempo,blink,lift)=>Object.freeze({brow,browTalk,tilt,sway,nod,tempo,blink,lift});
  const styles=Object.freeze({
    neutral:   style(0.00,0.35, 0.00,1.0,1.0,1.00,1.00, 0.0),
    warm:      style(0.15,0.35, 0.35,1.0,1.0,0.90,1.00, 0.0),
    tender:    style(0.10,0.20, 0.50,0.7,0.6,0.70,1.10, 0.3),
    calm:      style(0.05,0.20, 0.10,0.6,0.5,0.70,1.10, 0.0),
    confident: style(0.10,0.30, 0.15,0.8,0.9,0.95,1.10,-0.3),
    amused:    style(0.35,0.40,-0.45,1.2,1.6,1.15,0.95,-0.2),
    playful:   style(0.30,0.45,-0.60,1.4,1.3,1.20,0.90, 0.0),
    excited:   style(0.55,0.45, 0.00,1.5,2.0,1.40,0.80,-0.6),
    smug:      style(0.25,0.20, 0.70,0.8,0.5,0.80,1.20,-0.3),
    curious:   style(0.40,0.35, 0.60,0.9,0.8,1.00,1.00, 0.0),
    thoughtful:style(0.15,0.15, 0.45,0.5,0.3,0.60,1.20, 0.0),
    skeptical: style(0.45,0.15, 0.65,0.6,0.4,0.80,1.15, 0.0),
    dry:       style(0.05,0.10, 0.20,0.4,0.3,0.70,1.30, 0.0),
    serious:   style(0.00,0.15, 0.00,0.45,0.5,0.75,1.20, 0.0),
    frustrated:style(0.05,0.10,-0.25,0.9,1.4,1.30,1.10, 0.2),
    angry:     style(0.00,0.05, 0.00,0.9,1.8,1.50,1.40, 0.5),
    disgusted: style(0.10,0.10,-0.60,0.5,0.4,0.90,1.10, 0.0),
    surprised: style(0.90,0.10, 0.00,0.7,1.5,1.20,1.50,-0.8),
    afraid:    style(0.70,0.20, 0.00,0.5,0.6,1.50,0.60, 0.0),
    concerned: style(0.50,0.20,-0.40,0.6,0.5,0.75,1.00, 0.2),
    sad:       style(0.40,0.10,-0.50,0.4,0.3,0.60,0.85, 0.8),
    tired:     style(0.00,0.10,-0.30,0.4,0.3,0.50,0.60, 0.6),
  });
  const expressionStyle=(name)=>styles[name]||styles.neutral;

  function cue(tag) {
    const s=String(tag).toLowerCase().trim().replace(/[‘’]/g,"'").replace(/\s+/g,' ');
    if(s==='reset')return {expression:'neutral',kind:'reset'};
    if(sounds.has(s))return {expression:sounds.get(s),kind:'moment'};
    const bare=s.replace(/^(?:soft|small|little|quiet|big|loud|short|long|dry|sharp|warm|tiny) /,'').replace(/s$/,'');
    if(s.split(' ').length<=3&&sounds.has(bare))return {expression:sounds.get(bare),kind:'moment'};
    if(s.length>160)return {expression:'neutral',kind:'direction'};
    // "warm but not letting it slide" is still warm; "not amused" is nothing.
    // Drop each negated phrase rather than inventing its opposite.
    const kept=s.replace(NEGATED,' ');
    return {expression:rules.find(([,re])=>re.test(kept))?.[0]||'neutral',kind:'direction'};
  }
  function timeline(text) {
    if(typeof text!=='string'||text.length>100000)throw new RangeError('Expected at most 100,000 characters');
    const out=[];const re=/%%%([^%\n]{1,160})%%%/g;let m;
    while((m=re.exec(text)))out.push({offset:m.index,end:re.lastIndex,tag:m[1],...cue(m[1])});
    return out;
  }
  // Caller invokes cues when their audio segment PLAYS, not when text arrives.
  // A one-shot temporarily overlays the persistent direction, then returns.
  function controller() {
    let base='neutral',moment=null,owner=null,revision=0;
    return {
      start(id){owner=id;base='neutral';moment=null;revision++;return this.state();},
      apply(id,tag){if(id!==owner||owner===null)return this.state();revision++;const c=cue(tag);if(c.kind==='moment')moment=c.expression||base;else{base=c.expression;moment=null;}return this.state();},
      endMoment(id,token){if(id===owner&&token===revision)moment=null;return this.state();},
      stop(id){if(id===owner){owner=null;base='neutral';moment=null;revision++;}return this.state();},
      state(){return {owner,expression:moment||base,persistent:base,moment:!!moment,revision};},
    };
  }
  return {cue,timeline,controller,expressionStyle,expressions:Object.freeze(Object.keys(styles))};
})();
export default AvatarExpression;
