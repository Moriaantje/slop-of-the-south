# Street furniture points (see db/migrate/*_create_poles.rb). BGT Paal types are kept as they are, except the ones
# the game renders, which get short kinds.
class Pole < ApplicationRecord
  KINDS = { "lichtmast" => "lamp", "verkeersregelinstallatiepaal" => "signal", "verkeersbordpaal" => "sign_post" }.freeze
end
