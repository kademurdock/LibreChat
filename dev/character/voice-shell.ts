export const useLocalize = () => (key: string) => ({ com_ui_voice_portrait_pause:'Pause voice message', com_ui_voice_portrait_resume:'Resume voice message', com_ui_voice_portrait_play_error:'Playback could not resume. Try Resume again.' }[key] || key);
export function useGetAgentByIdQuery(id: string, options: any) {
 return { data: options.enabled ? { id, avatar: { filepath: id === 'agent_6llV0eMu4fmIaj8f2x1Sb' ? '/agent-agent_6llV0eMu4fmIaj8f2x1Sb-avatar-1788871984269.png' : id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? '/agent-agent_BSOLa3eNEZyjs-7abCjMt-avatar-1788941611099.png' : '/test-portrait.svg' } } : undefined };
}
