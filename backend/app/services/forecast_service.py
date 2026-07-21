"""Feature engineering for the v2 LSTM forecast model (technical-indicator based)."""
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

LOOKBACK = 60   # days of history per input window (shared by v2)

# ── v2: technical-indicator feature engineering ─────────────
import pandas as pd
from app.services.scanner_engine import compute_rsi, compute_macd, compute_sma, compute_bbands

FEATURE_NAMES = ["rsi", "macd_hist", "sma_dist", "bb_pctb", "rel_volume", "daily_return"]
N_FEATURES = len(FEATURE_NAMES)
HORIZON_V2 = 5
CALIBRATION_DAYS = 40  # bars held out from training, used only to calibrate band width


def compute_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    """df must have columns: close, high, low, volume, ascending by date (any index).
    Returns a DataFrame with FEATURE_NAMES columns, same length/index as df.
    Early rows are NaN where indicators need warmup history (e.g. RSI(14), SMA(20)).
    """
    close = df["close"]
    volume = df["volume"]

    rsi = compute_rsi(close, 14)
    macd_hist = compute_macd(close)["histogram"]

    sma20 = compute_sma(close, 20)
    sma_dist = (close - sma20) / sma20 * 100

    bb = compute_bbands(close, 20, 2.0)
    bb_range = (bb["upper"] - bb["lower"]).replace(0, np.nan)
    bb_pctb = (close - bb["lower"]) / bb_range

    vol_avg20 = volume.rolling(20).mean()
    rel_volume = volume / vol_avg20.replace(0, np.nan)

    daily_return = close.pct_change() * 100

    return pd.DataFrame({
        "rsi": rsi,
        "macd_hist": macd_hist,
        "sma_dist": sma_dist,
        "bb_pctb": bb_pctb,
        "rel_volume": rel_volume,
        "daily_return": daily_return,
    })


def build_relative_sequences(stock_df: pd.DataFrame, nifty_close: pd.Series):
    """Build (X, y) for the v2 model.

    stock_df: DataFrame with columns close, high, low, volume, ascending by date,
              index aligned 1:1 by position with nifty_close (both must be the
              same length and date-aligned by the caller — this function does NOT
              do a date join, callers must pre-align via a pandas merge on date).
    nifty_close: Series of NIFTY_50 close prices, same length/order as stock_df.

    Returns (X, y):
      X: (n_samples, LOOKBACK, N_FEATURES) float32, each window z-score normalized
         using that window's own per-feature mean/std (handles regime changes
         better than a single global normalization).
      y: (n_samples, HORIZON_V2) float32, target[i, h] = the stock's cumulative
         return over the next h+1 days MINUS NIFTY's cumulative return over the
         same days (i.e. predicted "alpha", as a fraction e.g. 0.01 = 1%).

    Returns empty arrays if there isn't enough aligned history for one sample,
    or if stock_df and nifty_close lengths don't match.
    """
    if len(stock_df) != len(nifty_close):
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat = compute_feature_frame(stock_df)
    first_complete = feat.dropna().index.min() if not feat.dropna().empty else None
    if first_complete is None:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_arr = feat.to_numpy(dtype=np.float64)
    stock_close_arr = stock_df["close"].to_numpy(dtype=np.float64)
    nifty_close_arr = nifty_close.to_numpy(dtype=np.float64)

    n = len(feat_arr)
    warmup = int(first_complete) if isinstance(first_complete, (int, np.integer)) else feat.index.get_loc(first_complete)
    usable_n = n - warmup
    min_required = LOOKBACK + HORIZON_V2
    if usable_n < min_required:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_usable = feat_arr[warmup:]
    stock_close_usable = stock_close_arr[warmup:]
    nifty_close_usable = nifty_close_arr[warmup:]

    n_samples = usable_n - min_required + 1
    if n_samples <= 0:
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    # Vectorized sliding windows over the warmup-trimmed feature array.
    feat_windows = sliding_window_view(feat_usable, LOOKBACK, axis=0)[:n_samples]
    # sliding_window_view(feat_usable, LOOKBACK, axis=0) on a (T, N_FEATURES)
    # array produces (T-LOOKBACK+1, N_FEATURES, LOOKBACK) — transpose to get
    # (n_samples, LOOKBACK, N_FEATURES), matching what the rest of this
    # function and all callers expect.
    feat_windows = np.transpose(feat_windows, (0, 2, 1))  # (n_samples, LOOKBACK, N_FEATURES)

    anchor_idx = np.arange(n_samples) + LOOKBACK - 1  # (n_samples,)
    stock_anchor = stock_close_usable[anchor_idx]      # (n_samples,)
    nifty_anchor = nifty_close_usable[anchor_idx]      # (n_samples,)

    h_range = np.arange(HORIZON_V2)
    future_idx = anchor_idx[:, None] + 1 + h_range[None, :]  # (n_samples, HORIZON_V2)

    future_stock = stock_close_usable[future_idx]  # (n_samples, HORIZON_V2)
    future_nifty = nifty_close_usable[future_idx]  # (n_samples, HORIZON_V2)

    # Validity mask — same filtering rules as the original loop.
    window_valid = ~np.isnan(feat_windows).any(axis=(1, 2))
    anchor_valid = (stock_anchor > 0) & (nifty_anchor > 0)
    future_valid = (
        ~np.isnan(future_stock).any(axis=1)
        & ~np.isnan(future_nifty).any(axis=1)
        & (future_stock > 0).all(axis=1)
        & (future_nifty > 0).all(axis=1)
    )
    valid = window_valid & anchor_valid & future_valid

    if not valid.any():
        return np.empty((0, LOOKBACK, N_FEATURES)), np.empty((0, HORIZON_V2))

    feat_windows_v = feat_windows[valid]
    stock_anchor_v = stock_anchor[valid][:, None]
    nifty_anchor_v = nifty_anchor[valid][:, None]
    future_stock_v = future_stock[valid]
    future_nifty_v = future_nifty[valid]

    mean = feat_windows_v.mean(axis=1, keepdims=True)
    std = feat_windows_v.std(axis=1, keepdims=True)
    std = np.where(std > 1e-8, std, 1.0)
    X = ((feat_windows_v - mean) / std).astype(np.float32)

    stock_ret = (future_stock_v - stock_anchor_v) / stock_anchor_v
    nifty_ret = (future_nifty_v - nifty_anchor_v) / nifty_anchor_v
    alpha = stock_ret - nifty_ret
    # Clip extreme outliers (penny stocks, delistings, data anomalies).
    # ±50% over a 5-day window captures virtually all normal market moves;
    # values beyond this are typically bad data or extreme corporate events
    # that would dominate the gradient and prevent learning on normal stocks.
    y = np.clip(alpha, -0.5, 0.5).astype(np.float32)

    return X, y


def calibrate_bands(residuals_by_horizon: dict, coverage_target: float = 0.90) -> dict:
    """Given empirical (actual - predicted) residuals per horizon day from a
    calibration slice the model never trained on, compute a symmetric half-width
    per horizon day such that predicted +/- half_width covers `coverage_target`
    fraction of those residuals (e.g. the 90th percentile of |residual|).

    Returns {horizon_day: half_width}. Horizon days with no residuals get 0.0
    (caller should treat 0-width bands as "uncalibrated, don't trust" rather
    than a real zero-uncertainty claim).
    """
    half_widths = {}
    for h, residuals in residuals_by_horizon.items():
        residuals = np.asarray(residuals)
        if len(residuals) == 0:
            half_widths[h] = 0.0
            continue
        abs_res = np.abs(residuals)
        half_widths[h] = float(np.percentile(abs_res, coverage_target * 100))
    return half_widths
