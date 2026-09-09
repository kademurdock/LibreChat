import { useForm } from 'react-hook-form';
import { useState, ReactNode } from 'react';
import { Spinner, Button } from '@librechat/client';
import { useOutletContext } from 'react-router-dom';
import { useRequestPasswordResetMutation } from 'librechat-data-provider/react-query';
import { loginPage } from 'librechat-data-provider';
import type { TRequestPasswordReset } from 'librechat-data-provider';
import type { TLoginLayoutContext } from '~/common';
import type { FC } from 'react';
import { useLocalize } from '~/hooks';

const BodyTextWrapper: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <div
      className="relative mt-6 rounded-xl border border-green-500/20 bg-green-50/50 px-6 py-4 text-green-700 shadow-sm transition-all dark:bg-green-950/30 dark:text-green-100"
      role="alert"
    >
      {children}
    </div>
  );
};

const ResetPasswordBodyText = () => {
  const localize = useLocalize();
  return (
    <div className="flex flex-col space-y-4">
      <p>{localize('com_auth_reset_password_if_email_exists')}</p>
      <p>{localize('com_auth_recovery_inbox_help')}</p>
      <a
        className="inline-flex text-sm font-medium text-green-600 transition-colors hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
        href={loginPage()}
      >
        {localize('com_auth_back_to_login')}
      </a>
    </div>
  );
};

function RequestPasswordReset() {
  const localize = useLocalize();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<TRequestPasswordReset>();
  const [bodyText, setBodyText] = useState<ReactNode | undefined>(undefined);
  const [requestFailed, setRequestFailed] = useState(false);
  const { startupConfig, setHeaderText } = useOutletContext<TLoginLayoutContext>();

  const requestPasswordReset = useRequestPasswordResetMutation();
  const { isLoading } = requestPasswordReset;

  const onSubmit = (data: TRequestPasswordReset) => {
    setRequestFailed(false);
    requestPasswordReset.mutate(
      { ...data, email: data.email.trim().toLowerCase() },
      {
        onSuccess: () => {
          setHeaderText('com_auth_reset_password_link_sent');
          setBodyText(<ResetPasswordBodyText />);
        },
        onError: () => {
          setRequestFailed(true);
        },
      },
    );
  };

  if (bodyText) {
    return <BodyTextWrapper>{bodyText}</BodyTextWrapper>;
  }

  if (startupConfig?.emailEnabled === false || startupConfig?.passwordResetEnabled === false) {
    return (
      <BodyTextWrapper>
        <p>{localize('com_auth_recovery_unavailable')}</p>
        <a className="mt-4 block underline" href={loginPage()}>
          {localize('com_auth_back_to_login')}
        </a>
      </BodyTextWrapper>
    );
  }

  return (
    <form
      className="mt-8 space-y-6"
      aria-label={localize('com_auth_reset_password')}
      method="POST"
      onSubmit={handleSubmit(onSubmit)}
    >
      <p id="recovery-help" className="text-sm text-text-secondary-alt">
        {localize('com_auth_recovery_options')}
      </p>
      {requestFailed && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {localize('com_auth_recovery_request_failed')}
        </p>
      )}
      <div className="space-y-2">
        <div className="relative">
          <input
            type="email"
            id="email"
            autoComplete="email"
            inputMode="email"
            aria-describedby={errors.email ? 'recovery-help recovery-email-error' : 'recovery-help'}
            aria-label={localize('com_auth_email')}
            {...register('email', {
              required: localize('com_auth_email_required'),
              minLength: {
                value: 3,
                message: localize('com_auth_email_min_length'),
              },
              maxLength: {
                value: 120,
                message: localize('com_auth_email_max_length'),
              },
              pattern: {
                value: /\S+@\S+\.\S+/,
                message: localize('com_auth_email_pattern'),
              },
            })}
            aria-invalid={!!errors.email}
            className="webkit-dark-styles transition-color peer w-full rounded-2xl border border-border-light bg-surface-primary px-3.5 pb-2.5 pt-3 text-text-primary duration-200 focus:border-green-500 focus:outline-none"
            placeholder=" "
          />
          <label
            htmlFor="email"
            className="absolute -top-2 left-2 z-10 bg-white px-2 text-sm text-gray-600 transition-all peer-placeholder-shown:top-3 peer-placeholder-shown:text-base peer-placeholder-shown:text-gray-500 peer-focus:-top-2 peer-focus:text-sm peer-focus:text-green-600 dark:bg-gray-900 dark:text-gray-400 dark:peer-focus:text-green-500"
          >
            {localize('com_auth_email_address')}
          </label>
        </div>
        {errors.email && (
          <p
            id="recovery-email-error"
            role="alert"
            className="text-sm font-medium text-red-600 dark:text-red-400"
          >
            {errors.email.message}
          </p>
        )}
      </div>
      <div className="space-y-4">
        <Button
          aria-label={localize('com_auth_continue')}
          type="submit"
          disabled={!!errors.email || isLoading}
          variant="submit"
          className="h-12 w-full rounded-2xl"
        >
          {isLoading ? <Spinner /> : localize('com_auth_continue')}
        </Button>
        <a
          href={loginPage()}
          className="block text-center text-sm font-medium text-green-600 transition-colors hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
        >
          {localize('com_auth_back_to_login')}
        </a>
      </div>
    </form>
  );
}

export default RequestPasswordReset;
