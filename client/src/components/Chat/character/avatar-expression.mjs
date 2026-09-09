'use strict';
// A rendering cue, never a diagnosis of the character or user. This module
// performs no inference/network work and never changes the speech input.
const AvatarExpression = (() => {
  const sounds = new Map([
    ['laugh','amused'],['chuckle','amused'],['giggle','amused'],['cackle','amused'],
    ['scoff','skeptical'],['gasp','surprised'],['sigh','concerned'],['cry','concerned'],['sob','concerned'],
  ]);
  for(const name of ['breath','pant','huff','grunt','groan','moan','snort','wail','whimper','whine','sniffle','sniff','shriek','squeal','howl','clear throat','cough','sneeze','hiccup','yawn','burp','snore','choke','gag','swallow','gulp','spit','tongue click','mouth click','mouth sound','lip smack','kiss','shush','raspberry','whistle','bleh','chew','slurp','babble','beatbox','growl'])sounds.set(name,null);
  function cue(tag) {
    const s=String(tag).toLowerCase().trim().replace(/\s+/g,' ');
    if(s==='reset')return {expression:'neutral',kind:'reset'};
    if(sounds.has(s))return {expression:sounds.get(s),kind:'moment'};
    // Free-form directions can be ambiguous. Keep unrecognized or negated
    // directions neutral; don't invent emotional meaning from a word fragment.
    if(s.length>160||/\b(?:not|never|without|no)\b/.test(s))return {expression:'neutral',kind:'direction'};
    const rules=[
      ['concerned',/\b(?:sad|sadness|worried|concerned|sorrowful)\b/],
      ['serious',/\b(?:serious|solemn|firm)\b/],
      ['skeptical',/\b(?:skeptical|sceptical|doubtful|unconvinced)\b/],
      ['surprised',/\b(?:surprised|astonished|startled|shocked)\b/],
      ['amused',/\b(?:amused|playful|delighted|grinning|excited)\b/],
      ['warm',/\b(?:warm|fond|friendly|tender)\b/],
    ];
    return {expression:rules.find(([,re])=>re.test(s))?.[0]||'neutral',kind:'direction'};
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
  return {cue,timeline,controller};
})();
export default AvatarExpression;
