Rails.application.routes.draw do
  root "game#index"

  namespace :api do
    get "world",         to: "world#show"
    get "tiles/:tx/:ty", to: "tiles#show", constraints: { tx: /-?\d+/, ty: /-?\d+/ }
    get "map/overview",  to: "map#overview"
    get "map/:mx/:my",   to: "map#cell", constraints: { mx: /-?\d+/, my: /-?\d+/ }
  end

  mount ActionCable.server => "/cable"
end
