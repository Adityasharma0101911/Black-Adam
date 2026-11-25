import traceback
try:
    from src.ui.app import BlackAdamApp
    app = BlackAdamApp()
except Exception as e:
    traceback.print_exc()
