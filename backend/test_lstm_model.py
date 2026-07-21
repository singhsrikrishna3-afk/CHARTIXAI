"""Smoke test: tiny LSTM model can train one step and infer without error.
Run directly: python test_lstm_model.py
"""
import numpy as np
import torch
from app.ml.lstm_model import ForecastLSTM, train_one_epoch

failures = []

def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"PASS: {label}")

torch.manual_seed(0)

model = ForecastLSTM(input_size=2, hidden_size=8, horizon=10)
X = torch.randn(16, 60, 2)  # batch=16, lookback=60, features=2
y = torch.randn(16, 10)     # batch=16, horizon=10

# Forward pass shape check
out = model(X)
check("output shape matches (batch, horizon)", tuple(out.shape) == (16, 10))

# One training step should reduce loss (or at least run without error)
optimizer = torch.optim.Adam(model.parameters(), lr=0.01)
loss_before = train_one_epoch(model, X, y, optimizer)
loss_after = train_one_epoch(model, X, y, optimizer)
check("loss is a finite float", np.isfinite(loss_before) and np.isfinite(loss_after))
check("training reduces loss on repeated same-batch fitting", loss_after < loss_before)

from app.ml.lstm_model import predict_mean

model2 = ForecastLSTM(input_size=6, hidden_size=8, horizon=5)
X2 = torch.randn(4, 60, 6)
pred = predict_mean(model2, X2)

check("predict_mean output shape matches (batch, horizon)", tuple(pred.shape) == (4, 5))
check("predict_mean is deterministic (eval mode, no dropout randomness)",
      np.allclose(predict_mean(model2, X2), predict_mean(model2, X2)))

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("\nAll checks passed.")
