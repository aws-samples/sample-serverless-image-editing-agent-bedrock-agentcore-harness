import { useState, useEffect, useCallback } from 'react';
import {
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  fetchAuthSession,
  AuthUser,
} from 'aws-amplify/auth';
import type { AWSCredentials } from '@aws-amplify/core/internals/utils';

interface UseAuthReturn {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  getCredentials: () => Promise<AWSCredentials>;
}

export function useAuth(): UseAuthReturn {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
      setIsAuthenticated(true);
    } catch {
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }

  const signIn = useCallback(async (username: string, password: string) => {
    await amplifySignIn({ username, password });
    await checkAuth();
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const getCredentials = useCallback(async (): Promise<AWSCredentials> => {
    try {
      const session = await fetchAuthSession({ forceRefresh: false });
      if (!session.credentials) {
        throw new Error('No credentials available');
      }
      return session.credentials;
    } catch {
      // Credential refresh on session expiry - force refresh and retry
      const session = await fetchAuthSession({ forceRefresh: true });
      if (!session.credentials) {
        throw new Error('Unable to refresh credentials');
      }
      return session.credentials;
    }
  }, []);

  return {
    isAuthenticated,
    isLoading,
    user,
    signIn,
    signOut,
    getCredentials,
  };
}
