"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "../login/login.module.css"; // Reuse login styles for consistency

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await api.register({
        email,
        password,
        full_name: fullName,
        phone,
      });
      api.setToken(res.access_token);
      router.push("/dashboard");   // land on Overview after sign-up
    } catch (err) {
      setError(err.message || "Failed to create account. Check your details.");
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

        <h2 className={styles.title}>Create Account</h2>
        <p className={styles.subtitle}>Sign up to start tracking patterns and indicators</p>

        {error && <div className={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.inputGroup}>
            <label className={styles.label}>Full Name</label>
            <input
              type="text"
              className={styles.input}
              placeholder="John Doe"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </div>

          <div className={styles.inputGroup}>
            <label className={styles.label}>Email Address</label>
            <input
              type="email"
              className={styles.input}
              placeholder="john@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className={styles.inputGroup}>
            <label className={styles.label}>Phone Number</label>
            <input
              type="tel"
              className={styles.input}
              placeholder="1234567890"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
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
            {loading ? "Creating Account..." : "Sign Up"}
          </button>
        </form>

        <div className={styles.footerLink}>
          Already have an account? <span className={styles.link} onClick={() => router.push("/auth/login")}>Sign In</span>
        </div>
      </div>
    </div>
  );
}
