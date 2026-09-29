import { useEffect } from 'react';

export default function HomeRedirect() {
  useEffect(() => {
    window.location.replace('/home');
  }, []);
  return null;
}
