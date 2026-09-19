'use strict';

const { getChannelLogo, cleanChannelTitle, CDN_BASE } = require("../src/services/ChannelLogoService");

describe("ChannelLogoService mapping engine", () => {
  describe("UK & Premier League sports channels", () => {
    test("maps Sky Sports Premier League to jsDelivr CDN URL", () => {
      const url = getChannelLogo("Sky Sports Premier League");
      expect(url).toBeTruthy();
      expect(url).toContain(CDN_BASE);
      expect(url).toContain("sky-sports-premier-league-uk.png");
    });

    test("maps TNT Sports 1", () => {
      const url = getChannelLogo("TNT Sports 1");
      expect(url).toBeTruthy();
      expect(url).toContain("tnt-sports-1-uk.png");
    });

    test("maps Sky Sports Main Event", () => {
      const url = getChannelLogo("Sky Sports Main Event");
      expect(url).toBeTruthy();
      expect(url).toContain("sky-sports-main-event-uk.png");
    });
  });

  describe("US sports networks and national broadcasters", () => {
    test("maps Fox Sports 1 USA", () => {
      const url = getChannelLogo("Fox Sports 1 USA");
      expect(url).toBeTruthy();
      expect(url).toContain("fox-sports-1-us.png");
    });

    test("maps ESPN 2", () => {
      const url = getChannelLogo("ESPN 2");
      expect(url).toBeTruthy();
      expect(url).toContain("espn-2-us.png");
    });

    test("maps NFL RedZone", () => {
      const url = getChannelLogo("NFL RedZone");
      expect(url).toBeTruthy();
      expect(url).toContain("nfl-red-zone-us.png");
    });

    test("maps major US broadcast networks (ABC, CBS, NBC, Fox)", () => {
      expect(getChannelLogo("ABC USA")).toContain("abc-us.png");
      expect(getChannelLogo("CBS USA")).toContain("cbs-logo-white-us.png");
      expect(getChannelLogo("NBC USA")).toContain("nbc-us.png");
      expect(getChannelLogo("Fox USA")).toContain("fox-us.png");
    });
  });

  describe("International and regional networks", () => {
    test("maps SuperSport Grandstand (South Africa)", () => {
      const url = getChannelLogo("SuperSport Grandstand");
      expect(url).toBeTruthy();
      expect(url).toContain("supersport-grandstand-za.png");
    });

    test("maps Astro SuperSport 1 (Malaysia)", () => {
      const url = getChannelLogo("Astro SuperSport 1");
      expect(url).toBeTruthy();
      expect(url).toContain("astro-supersport-bug-my.png");
    });

    test("maps Sport TV1 Portugal", () => {
      const url = getChannelLogo("Sport TV1 Portugal");
      expect(url).toBeTruthy();
      expect(url).toContain("sport-tv-1-pt.png");
    });

    test("maps Sport Klub 1 Croatia", () => {
      const url = getChannelLogo("Sport Klub 1 Croatia");
      expect(url).toBeTruthy();
      expect(url).toContain("sportklub-1-hd-hr.png");
    });

    test("maps Diema Sport Bulgaria", () => {
      const url = getChannelLogo("Diema Sport Bulgaria");
      expect(url).toBeTruthy();
      expect(url).toContain("diema-sport-hd-bg.png");
    });
  });

  describe("Edge cases and fallbacks", () => {
    test("returns null for non-existent or gibberish channel name", () => {
      expect(getChannelLogo("Some Completely Unknown NonExistent Channel XYZ 999")).toBeNull();
      expect(getChannelLogo("")).toBeNull();
      expect(getChannelLogo(null)).toBeNull();
      expect(getChannelLogo(undefined)).toBeNull();
    });

    test("cleanChannelTitle strips quality tags and extra symbols", () => {
      expect(cleanChannelTitle("Fox Sports 1 [HD] [24/7] (USA)")).toBe("fox sports 1 usa");
    });
  });
});
