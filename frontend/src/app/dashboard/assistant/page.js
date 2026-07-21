"use client";

import { useState, useEffect, useRef } from "react";
import { drawMiniChart } from "@/lib/miniChart";

// Mini candlestick chart for a result card — same renderer the scanner pages use
function MiniStockChart({ data }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !data || data.length < 2) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext("2d").scale(dpr, dpr);
    drawMiniChart(canvas, data.slice(-40), {
      upColor: "#26a69a",
      downColor: "#ef5350",
      bgColor: "#131722",
      gridColor: "#232838",
      borderColor: "#2a2e39",
      showVolume: true,
      showMA: true,
      maPeriod: 20,
      maColor: "#f59e0b",
    });
  }, [data]);

  if (!data) {
    return (
      <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", color: "#6b7280", background: "#131722", borderRadius: 6 }}>
        Loading chart…
      </div>
    );
  }
  if (data.length < 2) {
    return (
      <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", color: "#6b7280", background: "#131722", borderRadius: 6 }}>
        No chart data
      </div>
    );
  }
  return (
    <canvas ref={canvasRef} style={{ width: "100%", height: 110, display: "block", borderRadius: 6 }} />
  );
}
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import styles from "./assistant.module.css";

export default function AssistantPage() {
  const router = useRouter();

  // Hand results to the chart page's step-through navigator (one stock at a time)
  const viewAllOnChart = (matches, label) => {
    try {
      sessionStorage.setItem("chartix_result_nav", JSON.stringify({
        matches: (matches || []).map(m => ({ symbol: m.symbol })),
        label: label || "Assistant scan",
        index: 0,
      }));
    } catch (e) { /* storage unavailable */ }
    router.push("/dashboard/charts");
  };

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Persistent chat history + per-symbol EOD cache for mini charts
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [chartCache, setChartCache] = useState({});

  // Restore previous session's conversation
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chartix_assistant_history");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
      }
    } catch (e) { /* corrupt/unavailable storage — start fresh */ }
    setHistoryLoaded(true);
  }, []);

  // Save history (gated on historyLoaded so defaults never clobber saved data)
  useEffect(() => {
    if (!historyLoaded) return;
    try {
      // keep the last 40 messages, and at most 20 matches per message
      const slim = messages.slice(-40).map(m => ({
        ...m,
        matches: (m.matches || []).slice(0, 20),
      }));
      localStorage.setItem("chartix_assistant_history", JSON.stringify(slim));
    } catch (e) { /* storage full — ignore */ }
  }, [messages, historyLoaded]);

  // Fetch EOD data for any result symbols not yet cached (top 12 per message),
  // so every stock card gets a mini chart like the scanner pages.
  useEffect(() => {
    if (!historyLoaded) return;
    const wanted = [];
    for (const m of messages) {
      if (m.sender !== "assistant") continue;
      for (const s of (m.matches || []).slice(0, 12)) {
        if (chartCache[s.symbol] === undefined && !wanted.includes(s.symbol)) wanted.push(s.symbol);
      }
    }
    if (!wanted.length) return;
    let cancelled = false;
    (async () => {
      const updates = {};
      await Promise.allSettled(wanted.slice(0, 24).map(async (sym) => {
        try {
          const data = await api.getEod(sym);
          updates[sym] = (data || []).map(d => ({
            open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
          }));
        } catch (_) { updates[sym] = []; }
      }));
      if (!cancelled) setChartCache(prev => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
  }, [messages, historyLoaded]);

  const clearHistory = () => {
    setMessages([]);
    try { localStorage.removeItem("chartix_assistant_history"); } catch (e) {}
  };
  const chatAreaRef = useRef(null);

  // Suggested prompts to show at the start or on failure
  const suggestedPrompts = [
    {
      label: "Fundamental stocks reversing after a correction",
      query: "best fundamental stock which is reversing after a correction",
      category: "🧠 Smart Combo"
    },
    {
      label: "Undervalued dividend stocks in an uptrend",
      query: "undervalued dividend stocks in an uptrend",
      category: "🧠 Smart Combo"
    },
    {
      label: "Quality midcaps with momentum and volume surge",
      query: "quality midcap stocks with momentum and volume surge",
      category: "🧠 Smart Combo"
    },
    {
      label: "Golden Crossover in Nifty 50",
      query: "find golden crossover in nifty 50 daily",
      category: "Moving Average"
    },
    {
      label: "RSI Oversold in Nifty 200",
      query: "RSI oversold in nifty 200 daily",
      category: "Indicator Scan"
    },
    {
      label: "Doji in Bullion Daily",
      query: "scan for doji in bullion daily",
      category: "Candlestick Pattern"
    },
    {
      label: "Double Bottom in Base Metals",
      query: "find double bottom in base metals weekly",
      category: "Chart Pattern"
    }
  ];

  // Auto-scroll to the bottom of the chat window whenever messages update
  useEffect(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleSend = async (text) => {
    if (!text.trim() || loading) return;

    // Add user message to state
    const userMessage = {
      id: Date.now(),
      sender: "user",
      text: text.trim()
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      // Call backend chatbot query API
      const res = await api.chatbotQuery(text.trim());
      
      const assistantMessage = {
        id: Date.now() + 1,
        sender: "assistant",
        text: res.message,
        success: res.success,
        intent: res.intent,
        matches: res.matches || [],
        forecast: res.forecast || null
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (err) {
      const errorMessage = {
        id: Date.now() + 1,
        sender: "assistant",
        text: err.message || "Sorry, I encountered an error while running the scan. Please verify that your query is structured correctly or try another prompt.",
        success: false,
        matches: []
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter") {
      handleSend(input);
    }
  };

  return (
    <div className={styles.assistantContainer}>
      {/* Header */}
      <div className={styles.assistantHeader}>
        <div className={styles.headerIcon}>💬</div>
        <div className={styles.headerTitle}>
          <h1>Scan Assistant</h1>
          <p>Describe your scan in plain English to run database queries instantly. No LLM hallucinations.</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearHistory}
            title="Clear conversation history"
            style={{
              marginLeft: "auto", alignSelf: "center",
              background: "transparent", color: "var(--text-muted, #9ca3af)",
              border: "1px solid var(--border-default, #333)", borderRadius: 8,
              padding: "6px 14px", fontSize: "0.78rem", cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            🗑 Clear history
          </button>
        )}
      </div>

      {/* Chat Area */}
      <div className={styles.chatArea} ref={chatAreaRef}>
        {messages.length === 0 ? (
          // Welcome / Suggestion Screen
          <div className={styles.welcomeSection}>
            <div className={styles.welcomeIcon}>🔮</div>
            <h2>Welcome to Chartix Assistant</h2>
            <p>
              Type your scan criteria using natural terms. I will analyze your request, extract parameters, and execute the exact database query. Try clicking one of these sample scans:
            </p>
            <div className={styles.suggestionsGrid}>
              {suggestedPrompts.map((p, index) => (
                <button
                  key={index}
                  className={styles.suggestionButton}
                  onClick={() => handleSend(p.query)}
                >
                  <span className={styles.suggestionLabel}>{p.category}</span>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          // Conversation View
          messages.map((m) => {
            const isUser = m.sender === "user";
            return (
              <div
                key={m.id}
                className={`${styles.messageRow} ${isUser ? styles.messageRowUser : styles.messageRowAssistant}`}
              >
                <div
                  className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant} ${!isUser && !m.success ? styles.bubbleGuide : ""}`}
                >
                  {/* Text Message */}
                  <div>{m.text}</div>

                  {/* Scan Results Grid (for assistant messages) */}
                  {!isUser && m.matches && m.matches.length > 0 && (
                    <div className={styles.resultsContainer}>
                      <div className={styles.resultsGrid}>
                        {m.matches.slice(0, 12).map((stock, sIdx) => {
                          const hasPrice = stock.close !== null;
                          const isPositive = stock.change_pct >= 0;
                          
                          // Resolve chart timeframe parameter for link
                          const tfParam = m.intent?.timeframe || "D";
                          const chartLink = `/dashboard/charts?symbol=${stock.symbol}&tf=${tfParam}`;

                          return (
                            <div key={sIdx} className={styles.stockCard}>
                              <MiniStockChart data={chartCache[stock.symbol]} />
                              <div className={styles.stockMeta}>
                                <span className={styles.stockSymbol}>{stock.symbol}</span>
                                <span className={styles.stockName}>{stock.name || "—"}</span>
                                <span className={styles.stockSector}>{stock.sector}</span>
                              </div>
                              
                              <div className={styles.stockPriceRow}>
                                {hasPrice ? (
                                  <>
                                    <span className={styles.stockPrice}>₹{stock.close.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                                    <span className={`${styles.stockChange} ${isPositive ? styles.changePositive : styles.changeNegative}`}>
                                      {isPositive ? "+" : ""}{stock.change_pct.toFixed(2)}%
                                    </span>
                                  </>
                                ) : (
                                  <span className={styles.extraDetails}>
                                    {stock.extra_details || "Pattern Detected"}
                                  </span>
                                )}
                              </div>

                              <Link href={chartLink} className={styles.chartLink}>
                                Chart →
                              </Link>
                            </div>
                          );
                        })}
                      </div>
                      
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "8px", gap: "8px" }}>
                        <button
                          onClick={() => viewAllOnChart(m.matches, `Assistant · ${(m.intent?.parameters?.concepts || []).join(" + ") || "scan"}`)}
                          style={{
                            background: "#2962ff", color: "#fff", border: "none",
                            borderRadius: 8, padding: "8px 16px", fontSize: "0.8rem",
                            fontWeight: 600, cursor: "pointer",
                          }}
                        >
                          ▶ View all on chart ({m.matches.length})
                        </button>
                        {m.matches.length > 12 && (
                          <div style={{ fontSize: "0.8rem", color: "#9ca3af", fontStyle: "italic" }}>
                            Showing top 12 of {m.matches.length} matches.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Forecast Result (for assistant messages) */}
                  {!isUser && m.forecast && (
                    <div className={styles.resultsContainer}>
                      <p style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
                        {m.forecast.symbol} — {m.forecast.is_stale ? "Forecast (stale)" : `as of ${m.forecast.as_of_date}`}
                      </p>
                      <Link href={`/dashboard/charts?symbol=${m.forecast.symbol}&tf=D`} className={styles.chartLink}>
                        View full forecast on chart →
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Loading Indicator */}
        {loading && (
          <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
            <div className={`${styles.bubble} ${styles.bubbleAssistant} ${styles.typingIndicator}`}>
              <div className={styles.dot}></div>
              <div className={styles.dot}></div>
              <div className={styles.dot}></div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className={styles.inputArea}>
        <input
          type="text"
          className={styles.inputField}
          placeholder="Describe your scan (e.g. 'RSI oversold in Nifty 50' or 'Doji in Bullion daily')..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyPress}
          disabled={loading}
        />
        <button
          className={styles.sendButton}
          onClick={() => handleSend(input)}
          disabled={!input.trim() || loading}
        >
          ➔
        </button>
      </div>
    </div>
  );
}
