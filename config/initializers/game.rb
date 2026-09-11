# Code reloading in development unloads Game::*; stop the round threads first so the next subscription starts
# fresh ones instead of leaving orphans ticking on stale classes.
Rails.application.reloader.before_class_unload { Game::RoundManager.shutdown } if Rails.env.development?
