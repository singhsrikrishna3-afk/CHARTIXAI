"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./login.module.css";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await api.login({ email, password });
      api.setToken(res.access_token);
      router.push("/dashboard");   // land on Overview after sign-in
    } catch (err) {
      setError(err.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.authWrapper}>
      <div className={styles.authCard}>
        <div className={styles.logoSection}>
          <img src="/logo.svg" alt="Chartix" style={{ width: "48px", height: "48px", borderRadius: "12px" }} />
          <h1 className={styles.logoText}>Chartix</h1>
          <p className={styles.tagline}>AI-Powered Technical Analysis Platform</p>
        </div>

        <h2 className={styles.title}>Welcome Back</h2>
        <p className={styles.subtitle}>Log in to access scanners, charts, and alerts</p>

        {error && <div className={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.inputGroup}>
            <label className={styles.label}>Email Address</label>
            <input
              type="email"
              className={styles.input}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className={styles.inputGroup}>
            <label className={styles.label}>Password</label>
            <input
              type="password"
              className={styles.input}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button type="submit" className={styles.loginBtn} disabled={loading}>
            {loading ? "Authenticating..." : "Sign In"}
          </button>
        </form>

        <div className={styles.footerLink}>
          Don't have an account? <span className={styles.link} onClick={() => router.push("/auth/register")}>Sign Up</span>
        </div>
      </div>
    </div>
  );
}
