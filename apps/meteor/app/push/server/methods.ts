import { Accounts } from 'meteor/accounts-base';
import { Meteor } from 'meteor/meteor';
import { Match, check } from 'meteor/check';
import { Random } from '@rocket.chat/random';
import type { ServerMethods } from '@rocket.chat/ui-contexts';
import type { Mongo } from 'meteor/mongo';

import { _matchToken, appTokensCollection } from './push';
import { logger } from './logger';

declare module '@rocket.chat/ui-contexts' {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface ServerMethods {
		'raix:push-update'(options: {
			id?: string;
			token: string;
			authToken: string;
			appName: string;
			userId?: string;
			metadata?: Record<string, unknown>;
		}): void;
		'raix:push-setuser'(options: { id: string; userId: string }): boolean;
	}
}

Meteor.methods<ServerMethods>({
	'raix:push-update'(options) {
		logger.debug('Got push token from app:', options);

		check(options, {
			id: Match.Optional(String),
			token: _matchToken,
			authToken: String,
			appName: String,
			userId: Match.OneOf(String, null),
			metadata: Match.Optional(Object),
		});

		// The if user id is set then user id should match on client and connection
		if (options.userId && options.userId !== this.userId) {
			throw new Meteor.Error(403, 'Forbidden access');
		}

		// we always store the hashed token to protect users
		const hashedToken = Accounts._hashLoginToken(options.authToken);

		let doc;

		// lookup app by id if one was included
		if (options.id) {
			doc = appTokensCollection.findOne({ _id: options.id });
		} else if (options.userId) {
			doc = appTokensCollection.findOne({ userId: options.userId });
		}

		// No doc was found - we check the database to see if
		// we can find a match for the app via token and appName
		if (!doc) {
			doc = appTokensCollection.findOne({
				$and: [
					{ token: options.token }, // Match token
					{ appName: options.appName }, // Match appName
					{ token: { $exists: true } }, // Make sure token exists
				],
			});
		}

		// if we could not find the id or token then create it
		if (!doc) {
			// Rig default doc
			doc = {
				token: options.token,
				authToken: hashedToken,
				appName: options.appName,
				userId: options.userId,
				enabled: true,
				createdAt: new Date(),
				updatedAt: new Date(),

				// XXX: We might want to check the id - Why isnt there a match for id
				// in the Meteor check... Normal length 17 (could be larger), and
				// numbers+letters are used in Random.id() with exception of 0 and 1
				_id: options.id || Random.id(),
				// The user wanted us to use a specific id, we didn't find this while
				// searching. The client could depend on the id eg. as reference so
				// we respect this and try to create a document with the selected id;
			};

			(appTokensCollection as Mongo.Collection<any> & { _collection: Mongo.Collection<any> })._collection.insert(doc);
		} else {
			// We found the app so update the updatedAt and set the token
			appTokensCollection.update(
				{ _id: doc._id },
				{
					$set: {
						updatedAt: new Date(),
						token: options.token,
						authToken: hashedToken,
					},
				},
			);
		}

		if (doc.token) {
			const removed = appTokensCollection.remove({
				$and: [
					{ _id: { $ne: doc._id } },
					{ token: doc.token }, // Match token
					{ appName: doc.appName }, // Match appName
					{ token: { $exists: true } }, // Make sure token exists
				],
			});

			if (removed) {
				logger.debug(`Removed ${removed} existing app items`);
			}
		}

		logger.debug('updated', doc);

		// Return the doc we want to use
		return doc;
	},
	// Deprecated
	'raix:push-setuser'(id) {
		check(id, String);

		logger.debug(`Settings userId "${this.userId}" for app:`, id);
		const found = appTokensCollection.update({ _id: id }, { $set: { userId: this.userId } });

		return !!found;
	},
});
