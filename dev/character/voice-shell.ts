import translations from '../../client/src/locales/en/translation.json';
export const useLocalize = () => (key: keyof typeof translations) => translations[key] || key;
export function useGetAgentByIdQuery(id: string | null | undefined, options: { enabled: boolean }) {
 return { data: options.enabled ? { id, name: id === 'agent_6llV0eMu4fmIaj8f2x1Sb' ? 'Kiana' : id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? 'Della' : 'Test character', avatar: { filepath: id === 'agent_6llV0eMu4fmIaj8f2x1Sb' ? '/agent-agent_6llV0eMu4fmIaj8f2x1Sb-avatar-1789863013865.png' : id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? '/agent-agent_BSOLa3eNEZyjs-7abCjMt-avatar-1788941611099.png' : '/test-portrait.svg' } } : undefined };
}
