/**
 * PEESTOCK — Auth Store (Zustand)
 */

import { create } from "zustand";
import { api } from "@/lib/api";

export const useAuthStore = create((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  init: async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("peestock_token") : null;
    if (!token) {
      // Mock auth for local dev usage
      set({ 
        user: { email: "admin@peestock.io", full_name: "Admin User" }, 
        isAuthenticated: true, 
        isLoading: false 
      });
      return;
    }
    api.setToken(token);
    try {
      const user = await api.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      // Even if fetch fails, keep as authenticated for local dev
      set({ 
        user: { email: "admin@peestock.io", full_name: "Admin User" }, 
        isAuthenticated: true, 
        isLoading: false 
      });
    }
  },

  login: async (email, password) => {
    const res = await api.login({ email, password });
    api.setToken(res.access_token);
    set({ user: res.user, isAuthenticated: true });
    return res;
  },

  register: async (data) => {
    const res = await api.register(data);
    api.setToken(res.access_token);
    set({ user: res.user, isAuthenticated: true });
    return res;
  },

  logout: () => {
    api.clearToken();
    set({ user: null, isAuthenticated: false });
  },
}));
