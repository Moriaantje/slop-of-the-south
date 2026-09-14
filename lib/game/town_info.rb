require "net/http"

module Game
  # What the loading screen tells about the town: a few lines and some pictures from the Dutch Wikipedia. Looked up
  # once per town per process; anything that goes wrong yields a plain fallback, so a round never waits on Wikipedia.
  #
  # The people at the hubs quote this too, and that is why there are two doors into the cache. `fetch` is the blocking
  # one and belongs in a controller, where a request may wait four seconds on Wikipedia. `sentence` is the one the
  # quest dialogue uses: it is called from inside the world manager's mutex on the tick thread, where a blocking HTTP
  # call would stop every dragon in the room, so it only ever answers out of the cache and kicks off a background
  # look-up for next time. A person who has nothing to quote yet simply talks about something else.
  module TownInfo
    API = "https://nl.wikipedia.org/api/rest_v1/page"
    HEADERS = { "User-Agent" => "SlopOfTheSouth/1.0 (mijnstreek driving game)", "Accept" => "application/json" }.freeze
    KIND_NL = { "city" => "stad", "town" => "stadje", "village" => "dorp", "castle" => "kasteel", "ruins" => "ruïne", "abbey" => "abdij",
                "church" => "kerk", "chapel" => "kapel", "mill" => "molen", "monument" => "monument", "stadium" => "stadion",
                "industrial" => "industrieterrein", "museum" => "museum" }.freeze
    MAX_SENTENCE = 220                  # characters: longer than this and it reads as an encyclopaedia, not as a person
    @cache = {}
    @pending = {}
    @lock = Mutex.new

    def self.fetch(name, kind)
      have = @lock.synchronize { @cache[name] }
      return have if have
      info = lookup(name) || { title: name, extract: "#{name} is een #{KIND_NL[kind] || 'plaats'} in Limburg.", images: [] }
      @lock.synchronize { @cache[name] ||= info }
    end

    # One sentence about the place, for a person to quote, or nil when nothing is in the cache yet. Never blocks: the
    # first ask starts a background look-up and returns nil, the next one a few seconds later gets the sentence.
    def self.sentence(name, kind = nil)
      info = @lock.synchronize { @cache[name] }
      return trim(info[:extract]) if info
      prefetch(name, kind)
      nil
    end

    # start the look-up for a place in the background, at most once per place per process
    def self.prefetch(name, kind = nil)
      return if defined?(Rails) && Rails.env.test?              # a test suite has no business waiting on Wikipedia
      start = @lock.synchronize { @cache.key?(name) || @pending[name] ? false : @pending[name] = true }
      return unless start
      Thread.new do
        body = -> { fetch(name, kind) }
        defined?(Rails) ? Rails.application.executor.wrap(&body) : body.call
      rescue StandardError => e
        Rails.logger.warn("[town info] prefetch #{name}: #{e.class}: #{e.message}") if defined?(Rails)
      ensure
        @lock.synchronize { @pending.delete(name) }
      end
    end

    # for tests and for a room that should not talk to Wikipedia at all
    def self.seed(name, extract) = @lock.synchronize { @cache[name] = { title: name, extract:, images: [] } }

    # the first sentence, without the bracketed pronunciations and the trailing half sentence of a long one
    def self.trim(extract)
      text = extract.to_s.gsub(/\s+/, " ").strip
      return nil if text.empty?
      first = text[/\A.*?[.!?](?=\s|\z)/] || text
      first = first[0, MAX_SENTENCE].sub(/\s\S*\z/, "") + "…" if first.length > MAX_SENTENCE
      first.strip.presence
    end

    # the Limburg-specific article when there is one, else the plain one, else whatever a search for the town in
    # Limburg turns up under its name (Venlo and Nuth are disambiguation pages with "(stad)"/"(plaats)" articles)
    def self.lookup(name)
      titles = [ "#{name} (Limburg)", name, "#{name} (Nederland)" ]
      titles.concat(search(name)) if titles.none? { (page = get("summary/#{CGI.escape(_1.tr(' ', '_'))}")) && page["type"] == "standard" }
      titles.uniq.each do |title|
        page = get("summary/#{CGI.escape(title.tr(' ', '_'))}") or next
        next unless page["type"] == "standard"
        lead = page.dig("thumbnail", "source")&.sub(%r{/\d+px-}, "/1280px-")
        return { title: page["title"], extract: page["extract"], images: [ lead, *pictures(title) ].compact.uniq.first(4) }
      end
      nil
    rescue StandardError => e
      Rails.logger.warn("[town info] #{name}: #{e.class}: #{e.message}")
      nil
    end

    # the photographs in the article as 1280 px thumbs; flags, coats of arms and maps are drawings and stay out
    def self.pictures(title)
      list = get("media-list/#{CGI.escape(title.tr(' ', '_'))}") or return []
      list["items"].to_a.filter_map do |item|
        src = item.dig("srcset", 0, "src").to_s[/\A[^?]*/]
        "https:#{src.sub(%r{/\d+px-}, "/1280px-")}" if item["type"] == "image" && src.match?(/\.jpe?g\z/i)
      end
    end

    # article titles for the town from a full-text search, "Venlo (stad)" style ones first
    def self.search(name)
      uri = URI("https://nl.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=#{CGI.escape("#{name} Limburg")}")
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 3, read_timeout: 4) { _1.get(uri.request_uri, HEADERS) }
      return [] unless res.is_a?(Net::HTTPSuccess)
      JSON.parse(res.body).dig("query", "search").to_a.map { _1["title"] }.select { _1.start_with?("#{name} (") }
    end

    def self.get(path)
      uri = URI("#{API}/#{path}")
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 3, read_timeout: 4) { _1.get(uri.request_uri, HEADERS) }
      JSON.parse(res.body) if res.is_a?(Net::HTTPSuccess)
    end
  end
end
