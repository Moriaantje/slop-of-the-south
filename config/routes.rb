Rails.application.routes.draw do
  root "game#index"

  namespace :api do
    get "world",         to: "world#show"
    get "tiles/:tx/:ty", to: "tiles#show", constraints: { tx: /-?\d+/, ty: /-?\d+/ }
  end

  # minimap base tiles (static-first: public/map/z/x/y.png once cached)
  get "map/:z/:x/:y", to: "map_tiles#show", constraints: { z: /\d+/, x: /\d+/, y: /\d+/ }, defaults: { format: "png" }

  mount ActionCable.server => "/cable"
end
