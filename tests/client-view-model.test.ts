import test from "node:test";
import assert from "node:assert/strict";

const { buildQueueRequest, editableSeasonValue, jobTitleLine, parseLinks, previewWithUpdatedDestinationPaths, statusLabel } = await import("../src/client/viewModel.js");

test("series job titles include season and episode when both are known", () => {
  assert.equal(
    jobTitleLine({
      title: "Better Call Saul",
      mediaType: "series",
      season: 2,
      episode: 3
    }),
    "Better Call Saul · S02E03"
  );
});

test("pasted duplicate links keep the first detected label", () => {
  const [link] = parseLinks([
    "Episode 03 https://example.com/better-call-saul-s02e03.mkv",
    "Repeated row https://example.com/better-call-saul-s02e03.mkv"
  ].join("\n"));

  assert.equal(link?.label, "Episode 03 https://example.com/better-call-saul-s02e03.mkv");
});

test("pasted HTML-escaped query separators are decoded before queueing", () => {
  const [link] = parseLinks("https://example.com/download?file=Better.Call.Saul.S02E03.mkv&amp;token=abc");

  assert.equal(link?.url, "https://example.com/download?file=Better.Call.Saul.S02E03.mkv&token=abc");
});

test("queue request payload normalizes form numbers before posting", () => {
  const request = buildQueueRequest({
    pageTitle: "Better Call Saul",
    selectedFolderName: undefined,
    preview: {
      title: "Better Call Saul",
      year: undefined,
      mediaType: "series",
      season: "2",
      matchedFolderName: "Better Call Saul",
      items: [
        {
          url: "https://example.com/better-call-saul-s02e03.mkv",
          label: "Episode 03",
          selected: true,
          episode: "3"
        }
      ]
    }
  });

  assert.equal(request.season, 2);
  assert.equal(request.links[0]?.episode, 3);
  assert.equal(request.folderName, "Better Call Saul");
});

test("season edit state can be fully cleared before queueing", () => {
  assert.equal(editableSeasonValue(""), "");
  assert.equal(editableSeasonValue("2"), "2");
  assert.equal(editableSeasonValue("S02"), "02");

  const request = buildQueueRequest({
    pageTitle: "Better Call Saul",
    selectedFolderName: undefined,
    preview: {
      title: "Better Call Saul",
      year: undefined,
      mediaType: "series",
      season: "",
      matchedFolderName: "Better Call Saul",
      items: []
    }
  });

  assert.equal(request.season, 1);
});

test("preview destination paths follow edited media type and season", () => {
  const basePreview = {
    title: "Better Call Saul",
    year: undefined,
    mediaType: "series" as const,
    season: "2",
    matchedFolderName: "Better Call Saul",
    libraryPaths: {
      movie: "/plex/Movies",
      series: "/plex/TV"
    },
    items: [
      {
        url: "https://example.com/better-call-saul-s02e03.mkv",
        selected: true,
        episode: "3",
        extension: ".mkv",
        destinationPath: "/plex/TV/Better Call Saul/Season 02/Better Call Saul - s02e03.mkv"
      }
    ]
  };

  const seasonPreview = previewWithUpdatedDestinationPaths({
    ...basePreview,
    season: "4"
  });

  assert.equal(
    seasonPreview.items[0]?.destinationPath,
    "/plex/TV/Better Call Saul/Season 04/Better Call Saul - s04e03.mkv"
  );

  const moviePreview = previewWithUpdatedDestinationPaths({
    ...basePreview,
    mediaType: "movie",
    matchedFolderName: undefined,
    year: "2021"
  });

  assert.equal(moviePreview.items[0]?.destinationPath, "/plex/Movies/Better Call Saul (2021)/Better Call Saul (2021).mkv");
});

test("job status values are formatted for display", () => {
  assert.equal(statusLabel("queued"), "Queued");
  assert.equal(statusLabel("canceled"), "Canceled");
  assert.equal(statusLabel("completed"), "Completed");
});
