"""LSTM model for multi-day price forecasting with quantile (band) outputs."""
import torch
import torch.nn as nn


class ForecastLSTM(nn.Module):
    def __init__(self, input_size=2, hidden_size=32, num_layers=2, horizon=10, dropout=0.2):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )
        self.head = nn.Linear(hidden_size, horizon)

    def forward(self, x):
        # x: (batch, lookback, features)
        out, (h_n, _) = self.lstm(x)
        last_hidden = h_n[-1]  # (batch, hidden_size)
        return self.head(last_hidden)  # (batch, horizon)


def train_one_epoch(model, X, y, optimizer):
    model.train()
    optimizer.zero_grad()
    pred = model(X)
    loss = nn.functional.mse_loss(pred, y)
    loss.backward()
    optimizer.step()
    return loss.item()



def predict_mean(model, X):
    """Single deterministic forward pass (eval mode, dropout off).
    Returns a numpy array, shape (batch, horizon). Used by v2, which gets its
    uncertainty band from empirical calibration (see forecast_service.calibrate_bands)
    rather than MC-dropout — v1's MC-dropout band was proven badly miscalibrated
    in the v1 backtest (5% actual coverage vs 90% target).
    """
    model.eval()
    with torch.no_grad():
        return model(X).numpy()
