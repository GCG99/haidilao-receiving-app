import { useEffect, useState } from "react";

export interface AuthUser {
  open_id?: string;
  name: string;
  avatar_url?: string;
}

export function useAuth() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) return null;
        const data = await response.json();
        return data.user as AuthUser;
      })
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  };

  return { authLoading, user, setUser, logout };
}
