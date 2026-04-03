import { defineStore } from 'pinia';
import { api } from 'boot/axios';

export interface User {
  id: number;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  date_joined: string;
}

export interface TokenPair {
  access: string;
  refresh: string;
}

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    currentUser: null as User | null,
    accessToken: localStorage.getItem(ACCESS_TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY),
  }),
  getters: {
    isAuthenticated: (state) => !!state.currentUser,
  },
  actions: {
    setTokens(tokens: TokenPair) {
      this.accessToken = tokens.access;
      this.refreshToken = tokens.refresh;
      localStorage.setItem(ACCESS_TOKEN_KEY, tokens.access);
      if (tokens.refresh) {
        localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh);
      }
    },
    clearSession() {
      this.accessToken = null;
      this.refreshToken = null;
      this.currentUser = null;
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    },
    async login(email: string, password: string): Promise<void> {
      const { data } = await api.post<TokenPair>('/auth/login/', { email, password });
      this.setTokens(data);
      await this.fetchUser();
    },
    async refreshTokenCall(): Promise<string> {
      if (!this.refreshToken) throw new Error('No refresh token');
      const { data } = await api.post<TokenPair>('/auth/refresh/', { refresh: this.refreshToken });
      this.setTokens(data);
      return data.access;
    },
    async fetchUser(): Promise<void> {
      const { data } = await api.get<User>('/auth/me/');
      this.currentUser = data;
    },
    async logout(): Promise<void> {
      if (this.refreshToken) {
        try {
          await api.post('/auth/logout/', { refresh: this.refreshToken });
        } catch (e) {
          // ignore error on logout
        }
      }
      this.clearSession();
    }
  }
});
