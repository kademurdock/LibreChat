import { act, fireEvent, render, screen } from '@testing-library/react';
import VerifyEmail from '../VerifyEmail';

let mockSearch = 'email=setup%40example.com&token=expired';
const mockVerify = jest.fn();
const mockResend = jest.fn();
let mockVerifyError: () => void;
let mockResendError: () => void;
let mockResendMutate: () => void;
jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(mockSearch)],
  useNavigate: () => jest.fn(),
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => null,
  ThemeSelector: () => null,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useVerifyEmailMutation: ({ onError }: { onError: () => void }) => {
    mockVerifyError = onError;
    return { mutate: mockVerify, isLoading: false };
  },
  useResendVerificationEmail: ({
    onError,
    onMutate,
  }: {
    onError: () => void;
    onMutate: () => void;
  }) => {
    mockResendError = onError;
    mockResendMutate = onMutate;
    return { mutate: mockResend, isLoading: false };
  },
}));

test('a failed verification offers resend immediately and permits retry after delivery failure', () => {
  render(<VerifyEmail />);
  act(() => mockVerifyError());
  fireEvent.click(screen.getByRole('button', { name: 'com_auth_email_resend_link' }));
  expect(mockResend).toHaveBeenCalledWith({ email: 'setup@example.com' });
  act(() => mockResendMutate());
  expect(screen.queryByRole('button', { name: 'com_auth_email_resend_link' })).toBeNull();
  act(() => mockResendError());
  expect(screen.getByRole('button', { name: 'com_auth_email_resend_link' })).toBeEnabled();
});

test('a verification URL with an email but no token offers resend without a stuck countdown', () => {
  mockSearch = 'email=setup%40example.com';
  render(<VerifyEmail />);
  expect(screen.getByRole('button', { name: 'com_auth_email_resend_link' })).toBeEnabled();
  expect(mockVerify).not.toHaveBeenCalled();
});
