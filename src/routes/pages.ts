import express from "express";
import {Router} from "express";
import {readFileSync} from 'fs';
import hbs from "handlebars";
import redis from "redis";

import * as constants   from "../constants";
import * as redisHelper from "../redis-helper";

function setRoutes(redisClient: redis.RedisClient): express.Router {
    const router = Router();

    hbs.registerHelper("stringify", (object: any): string => { return JSON.stringify(object); });

    hbs.registerHelper('gt', (a, b) => { return (a > b); });

    hbs.registerHelper("disableoptionifregion",
                       (object: Festival): string => { return object.name.length < 1 ? "disabled" : ""; });

    hbs.registerHelper('formatDate', (date: Date) => new hbs.SafeString(date.toDateString()));

    router.get("/health", (req: express.Request, res: express.Response) => res.send("healthy"));

    router.get("/", (req: express.Request, res: express.Response) => {
        const sortedFestivals: Festival[] = [...constants.supportedFestivals ];

        const regionCodes = [...new Set(constants.supportedFestivals.map(festival => festival.region)) ];

        // add regions to the dropdown as disabled values to provide section breaks
        for (const region of constants.regions) {
            if (regionCodes.includes(region.name))
                sortedFestivals.push({display_name : region.display_name, years : [], name : "", region : region.name});
        }

        sortedFestivals.sort((x: Festival, y: Festival) =>
                                 x.region.localeCompare(y.region) || x.name.localeCompare(y.name));

        res.render("home", {
            prod : process.env.DEPLOY_STAGE === 'PROD',
            supportedFestivals : sortedFestivals,
        });
    });

    router.get("/customize", async (req: express.Request, res: express.Response) => {
        if (!req.query.festival || !req.query.year) {
            return res.status(400).send("You need to choose a festival first.");
        }

        const queryYear: number = parseInt(req.query.year as string, 10);
        const festival: Festival =
            constants.supportedFestivals.filter(x => x.name === req.query.festival && x.years.includes(queryYear))[0];

        if (!festival || !festival.name) {
            return res.status(400).send("Invalid query params");
        }

        // Now get our session data
        // TODO :: this will change for multi-festival session data support
        let   tracksPerArtist: number             = 0;
        let   topTracksCheckedStr: string         = "";
        let   setlistTracksCheckedStr: string     = "";
        let   newTracksCheckedStr: string         = "";
        let   previouslySelectedArtists: string[] = null;
        let   previouslySelectedGenres: string[]  = null;
        let   previouslySelectedDays: string[]    = null;
        const sessionData: SessionData            = await redisHelper.getSessionData(redisClient, req.sessionUid);
        if (sessionData !== null && sessionData.festivalName === festival.name &&
            sessionData.festivalYear === queryYear) {
            // If the festival name and year matches what page we're loading, then fill in all selections / metadata
            // from session data. If the user has loaded this festival customize page before, but not saved any values,
            // we'll end up here but with none of the below options set, so we still fallback to default in here too
            tracksPerArtist = isNaN(sessionData.tracksPerArtist) ? 3 : sessionData.tracksPerArtist;

            if (sessionData.trackType === "top") {
                topTracksCheckedStr     = "checked";
                setlistTracksCheckedStr = "";
                newTracksCheckedStr     = "";
            } else if (sessionData.trackType === "setlist") {
                topTracksCheckedStr     = "";
                setlistTracksCheckedStr = "checked";
                newTracksCheckedStr     = "";
            } else if (sessionData.trackType === "recent") {
                topTracksCheckedStr     = "";
                setlistTracksCheckedStr = "";
                newTracksCheckedStr     = "checked";
            } else {
                console.error(`Resetting customize page to last known state and recieved unknown tracktype: ${
                    sessionData.trackType ? sessionData.trackType : "null or undefined"}`)
                topTracksCheckedStr     = "checked";
                setlistTracksCheckedStr = "";
                newTracksCheckedStr     = "";
            }

            previouslySelectedArtists = sessionData.artistIdsStr === undefined || sessionData.artistIdsStr === null
                                            ? null
                                            : sessionData.artistIdsStr.split(",");
            previouslySelectedGenres =
                sessionData.selectedGenresStr === undefined || sessionData.selectedGenresStr === null
                    ? null
                    : sessionData.selectedGenresStr.split(",");
            previouslySelectedDays = sessionData.selectedDaysStr === undefined || sessionData.selectedDaysStr === null
                                         ? null
                                         : sessionData.selectedDaysStr.split(",");
        } else {
            // Else save this festival info as our new session data
            const festivalName: string        = festival.name;
            const festivalDisplayName: string = festival.display_name;
            const festivalYear: number        = queryYear;

            const newSessionData: SessionData = {
                festivalName,
                festivalDisplayName,
                festivalYear,
            };

            tracksPerArtist         = 3;
            topTracksCheckedStr     = "checked";
            setlistTracksCheckedStr = "";
            newTracksCheckedStr     = "";

            // Remove old festivals metadata Save selected festival names/year
            // clang-format off
            redisClient.hdel(
                `sessionData:${req.sessionUid}`,
                "tracksPerArtist",
                "artistIdsStr",
                "trackIdsStr",
                "trackType",
                "playlistName",
                "selectedDaysStr",
                "selectedGenresStr",
                (err, obj) => {
                    if (err) {
                        console.error(err);
                    }
                }
            );

            redisClient.hmset(`sessionData:${req.sessionUid}`, newSessionData as any, redis.print);
            // clang-format on
        }

        // Get artists and work genre + session state-re-rendering magic
        const artists: SpotifyArtist[] = await redisHelper.getArtistsForFestival(redisClient, festival.name, queryYear);
        const mainGenresMap: Map<string, StatefulObject>     = new Map<string, StatefulObject>();
        const specificGenresMap: Map<string, StatefulObject> = new Map<string, StatefulObject>();
        const daysMap: Map<string, StatefulObject>           = new Map<string, StatefulObject>();

        const dayNumbers: number[] = await redisHelper.getLineupDays(redisClient, festival.name, queryYear);

        const daysWithMetadata: LineupDay[] = await Promise.all(dayNumbers.map(
            async (day) => redisHelper.getLineupDayMetadata(redisClient, festival.name, queryYear, day)));

        for (const lineupDay of daysWithMetadata) {
            const checkedStr =
                previouslySelectedDays === null || previouslySelectedDays.includes(lineupDay.number.toString())
                    ? "checked"
                    : "";

            daysMap.set(lineupDay.number.toString(), {state : checkedStr, obj : lineupDay});
        }

        const days: StatefulObject[] = Array.from(daysMap.values());
        days.sort();

        for (const artist of artists) {
            // Perform genre combining logic
            for (const genre of artist.combined_genres) {
                if (constants.mainGenres.includes(genre)) {
                    if (!mainGenresMap.has(genre)) {
                        // If it was null, we've never set any, so check everything. Otherwise, only check those we have
                        // previously
                        const checkedStr: string =
                            previouslySelectedGenres === null || previouslySelectedGenres.includes(genre) ? "checked"
                                                                                                          : "";
                        mainGenresMap.set(genre, {state : checkedStr, obj : genre});
                    }
                } else if (!specificGenresMap.has(genre)) {
                    // If it was null, we've never set any, so check everything. Otherwise, only check those we have
                    // previously
                    const checkedStr: string =
                        previouslySelectedGenres === null || previouslySelectedGenres.includes(genre) ? "checked" : "";
                    specificGenresMap.set(genre, {state : checkedStr, obj : genre});
                }
            }

            // Cheat with artists and just shove the checked value into the artist itself. Should refactor to use
            // StatefulObject buuuuuut
            if (previouslySelectedArtists === null || previouslySelectedArtists.includes(artist.id)) {
                artist.checkedStr = "checked";
            } else {
                artist.checkedStr = "";
            }
        }

        const mainGenres: StatefulObject[]     = Array.from(mainGenresMap.values());
        const specificGenres: StatefulObject[] = Array.from(specificGenresMap.values());
        mainGenres.sort();
        specificGenres.sort();

        const lastUpdatedDate = await redisHelper.getLineupLastUpdatedDate(redisClient, festival.name, queryYear);

        res.render("customize-list", {
            prod : process.env.DEPLOY_STAGE === 'PROD',
            titleOverride : `Customize Playlist - ${festival.display_name} ${queryYear}`,
            festival,
            festivalYear : queryYear,
            lastUpdatedDate,
            artists,
            mainGenres,
            specificGenres,
            days,
            tracksPerArtist,
            topTracksCheckedStr,
            setlistTracksCheckedStr,
            newTracksCheckedStr,
        });
    });

    router.get("/personalized-lineup", async (req: express.Request, res: express.Response) => {
        // make sure they didn't just navigate straight to this URL
        const sessionData: SessionData = await redisHelper.getSessionData(redisClient, req.sessionUid);
        if (sessionData === null) {
            return res.status(400).send("This url only accessible after generating a lineup from the customize page.");
        }

        const     artists: SpotifyArtist[] =
            await redisHelper.getArtistsForFestival(redisClient, sessionData.festivalName, sessionData.festivalYear);

        const chosenArtistIds = sessionData.artistIdsStr.split(",")
        const filteredArtists: SpotifyArtist[] =
            (chosenArtistIds && chosenArtistIds.length > 0) ? artists.filter(x => chosenArtistIds.includes(x.id)) : [];

        const artistsWithTracks: any = [];
        let   trackIds: string[]     = [];
        for (const artist of filteredArtists) {
            let tracksForArtist: SpotifyTrack[] = [];
            if (sessionData.trackType === "recent") {
                tracksForArtist =
                    await redisHelper.getNewestTracksForArtist(redisClient, artist, sessionData.tracksPerArtist);
            } else if (sessionData.trackType === "top") {
                tracksForArtist =
                    await redisHelper.getTopTracksForArtist(redisClient, artist, sessionData.tracksPerArtist);
            } else if (sessionData.trackType === "setlist") {
                tracksForArtist =
                    await redisHelper.getSetlistTracksForArtist(redisClient, artist, sessionData.tracksPerArtist);
            } else {
                console.warn(`Found track type of ${
                    sessionData.trackType ? sessionData.trackType
                                          : "undefined"} in session data, defaulting to top ttracks`);
                tracksForArtist =
                    await redisHelper.getTopTracksForArtist(redisClient, artist, sessionData.tracksPerArtist);
            }

            const artistWithTracks = {...artist, tracks : tracksForArtist}

                                     artistsWithTracks.push(artistWithTracks);
            if (tracksForArtist && tracksForArtist.length > 0) {
                trackIds = trackIds.concat(tracksForArtist.map(x => x.id))
            }
        }

        // Update our session data with track IDs
        // clang-format off
        redisClient.hmset(`sessionData:${req.sessionUid}`, {...sessionData, trackIdsStr : trackIds.join(",")});
        // clang-format on

        res.render("personalized-lineup", {
            prod : process.env.DEPLOY_STAGE === 'PROD',
            titleOverride : `Personalized Lineup - ${sessionData.festivalDisplayName} ${sessionData.festivalYear}`,
            festivalDisplayName : sessionData.festivalDisplayName,
            playlistName : `${sessionData.festivalDisplayName} ${sessionData.festivalYear} - Lineup List`,
            acts : artistsWithTracks,
            tracksPerArtist : sessionData.tracksPerArtist,
        })
    });

    router.get("/generate-playlist-success", async (req: express.Request, res: express.Response) => {
        const sessionData: SessionData = await redisHelper.getSessionData(redisClient, req.sessionUid);
        if (sessionData === null) {
            return res.status(403).send("This url only accessible after generating Spotify playlist.");
        }

        const festival: Festival = constants.supportedFestivals.filter(
            x => x.name === sessionData.festivalName && x.years.includes(sessionData.festivalYear))[0];
        const festivalYear: number = sessionData.festivalYear;

        res.render("generate-playlist-success", {
            prod : process.env.DEPLOY_STAGE === 'PROD',
            titleOverride : `${festival.display_name} ${festivalYear} Playlist Success`,
            festival,
            festivalYear,
            playlistName : sessionData.playlistName,
            playlistUrl : sessionData.playlistUrl,
        });
    });

    router.get("/faq", (req: express.Request, res: express.Response) => { res.render("faq"); });

    return router;
}

export default setRoutes;
