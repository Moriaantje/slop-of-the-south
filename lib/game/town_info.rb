require "net/http"

module Game
  # What the loading screen tells about the town: a few lines and some pictures from the Dutch Wikipedia. Looked up
  # once per town per process; anything that goes wrong yields a plain fallback, so a round never waits on Wikipedia.
  module TownInfo
    API = "https://nl.wikipedia.org/api/rest_v1/page"
    HEADERS = { "User-Agent" => "SlopOfTheSouth/1.0 (mijnstreek driving game)", "Accept" => "application/json" }.freeze
    KIND_NL = { "city" => "stad", "town" => "stadje", "village" => "dorp" }.freeze
    @cache = {}

    def self.fetch(name, kind)
      @cache[name] ||= lookup(name) || { title: name, extract: "#{name} is een #{KIND_NL[kind] || 'plaats'} in Limburg.", images: [] }
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
